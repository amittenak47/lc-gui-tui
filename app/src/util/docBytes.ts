/**
 * The bytes of a binary document, kept where bytes can actually live.
 *
 * Markdown annotation sets carry a copy of their source in the library JSON,
 * which works because a note is a few kilobytes of text. A textbook PDF is
 * tens of megabytes, and `localStorage` is a synchronous string store with a
 * quota around five — putting a PDF through it would be a base64 round trip on
 * the main thread that fails a third of the way in. IndexedDB takes the bytes
 * as-is, off the main thread, with no encoding.
 *
 * Keyed by content hash, exactly like the annotations that go with it. That is
 * what makes reopening a file from the library work without ever having known
 * where on disk it came from, and it is also why two copies of the same
 * textbook in two folders cost one entry rather than two.
 *
 * The connection and the transaction wrapper moved to `idb` when board content
 * needed the same database — they must share one open handle and one version
 * number, or two opens at different versions deadlock against each other.
 */

import { openDb, run, STORE_BYTES } from "./idb";
import { isCameraBusy } from "./cameraBusy";
import { traceOpen } from "./messageOf";

const STORE = STORE_BYTES;

function copyArrayBuffer(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

/**
 * Read a Blob, with a fallback for the ways a WebView refuses to.
 *
 * `arrayBuffer()` first — it is the standard path and the one the rest of the
 * app already relies on for text. An earlier version preferred `FileReader` on
 * Android; that branch was the only difference between the read that worked and
 * the read that did not, and it was never the cause. It is gone.
 *
 * Two things can still go wrong, and both are checked rather than assumed.
 * `arrayBuffer()` can *succeed* with a short buffer on a content URI, so the
 * length is compared against the Blob's own size. And `FileReader` on some
 * WebViews fires neither `load` nor `error`, so it is bounded — an unsettled
 * promise here would hang the open with nothing to show for it.
 */
export async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  const expected = blob.size;
  const finish = (buf: ArrayBuffer): ArrayBuffer => {
    if (expected > 0 && buf.byteLength !== expected) {
      throw new Error(`short read (${buf.byteLength} of ${expected})`);
    }
    return copyArrayBuffer(buf);
  };
  if (typeof blob.arrayBuffer === "function") {
    try {
      return finish(await blob.arrayBuffer());
    } catch (cause) {
      traceOpen("read: arrayBuffer() failed, trying FileReader", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return finish(await readBlobViaFileReader(blob));
}

/**
 * How long a FileReader gets before it is treated as never going to answer.
 *
 * Not a performance budget — it is generous enough for a slow textbook off a
 * content URI. It exists because the failure being guarded is silence: a
 * promise that never settles takes the whole open down with it, and the reader
 * sees a spinner rather than an error.
 */
const FILE_READER_TIMEOUT_MS = 30_000;

function readBlobViaFileReader(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("could not read the file"));
      return;
    }
    const reader = new FileReader();
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          reader.abort();
        } catch {
          /* already finished, or this WebView refuses to abort */
        }
        reject(new Error(`FileReader never answered after ${FILE_READER_TIMEOUT_MS}ms`));
      });
    }, FILE_READER_TIMEOUT_MS);
    reader.onload = () =>
      finish(() => {
        const result = reader.result;
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("could not read the file"));
      });
    reader.onerror = () =>
      finish(() => reject(reader.error ?? new Error("could not read the file")));
    reader.onabort = () => finish(() => reject(new Error("the read was aborted")));
    try {
      reader.readAsArrayBuffer(blob);
    } catch (cause) {
      finish(() => reject(cause));
    }
  });
}

/** Turn whatever IndexedDB gave back into bytes, or null if there are none. */
export async function bytesFromStoredValue(value: unknown): Promise<ArrayBuffer | null> {
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return value.byteLength > 0 ? value : null;
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength === 0) return null;
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (value.size === 0) return null;
    try {
      const bytes = await readBlobBytes(value);
      return bytes.byteLength > 0 ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Do these bytes belong under this key?
 *
 * The length {@link hashBytes} folds into the key answers it for free, and
 * every way content goes wrong on the way in — a truncated transfer, a hub
 * answering an error page with a 200 — changes the length. Keys this build did
 * not write carry no length, and are taken on trust rather than rejected.
 *
 * Cheap on purpose. A full rehash of a 40 MB textbook on every save would cost
 * more than the mistake it catches, and callers holding an untrusted payload
 * can still compare {@link hashBytes} themselves.
 */
export function bytesMatchDocHash(hash: string, bytes: ArrayBuffer): boolean {
  const want = lengthFromHash(hash);
  return want == null || bytes.byteLength === want;
}

export async function putDocBytes(hash: string, bytes: ArrayBuffer): Promise<void> {
  // The backstop for every writer, present and future. A row filed under a key
  // it does not match is the bug this whole file spent a week on: it survives
  // restarts, it is read back as the document, and the reader is told to
  // re-pick a file that was never the problem.
  if (!bytesMatchDocHash(hash, bytes)) {
    throw new Error(
      `refusing to store ${bytes.byteLength} bytes under ${hash}, which is not that document`,
    );
  }
  // Copy first. IndexedDB structured clone of an ArrayBuffer can detach the
  // original on Android WebView — then pdf.js is handed an empty buffer and
  // reports "Invalid PDF structure" for a file that still opens in Files.
  // ArrayBuffer, not Blob: a Blob put used to skip a 40 MB clone on save;
  // Android WebView then kept the key and lost the body after the process
  // died. Old Blob rows are still read by getDocBytes.
  const copy = copyArrayBuffer(bytes);
  await run(STORE, "readwrite", (store) => store.put(copy, hash));
}

/**
 * Store the bytes, then refuse to continue if IndexedDB does not actually
 * have them.
 *
 * `put` can resolve while the row is still missing on Android WebView. The
 * workspace that mounts next reads by hash; a chip with no row is the
 * "could not be opened" modal on the next launch.
 */
export async function putDocBytesVerified(hash: string, bytes: ArrayBuffer): Promise<void> {
  await putDocBytes(hash, bytes);
  const back = await getDocBytes(hash);
  if (!back || back.byteLength !== bytes.byteLength || !bytesMatchDocHash(hash, back)) {
    throw new Error("the file was not stored — try again");
  }
}

export async function getDocBytes(hash: string): Promise<ArrayBuffer | null> {
  const value = await run<unknown>(STORE, "readonly", (store) => store.get(hash));
  return bytesFromStoredValue(value);
}

/**
 * Local copy first, then an optional remote (the hub) if IndexedDB is empty
 * or its Blob is unreadable.
 *
 * Reopening from the library never looks at Android Files — there is no
 * stored URI — so this is the last place a missing local copy can come back
 * from without asking the reader to pick the file again.
 */
export async function loadBinaryDocBytes(
  hash: string,
  remote?: (hash: string) => Promise<ArrayBuffer | null>,
): Promise<ArrayBuffer | null> {
  if (!hash) return null;
  try {
    const local = await getDocBytes(hash);
    if (local && local.byteLength > 0) {
      /*
       * Check the stored row is still the document it is filed under.
       *
       * A row can be wrong without being unreadable. `getDocBytes` used to
       * cache whatever the hub answered with, and a hub that replies 200 with
       * a JSON or HTML body — an error page, a proxy's interstitial — lands
       * that text in IndexedDB under the document's key. From then on every
       * open reads a few hundred bytes back and the reader is told to pick
       * their file again, which cannot help: the bad copy is the app's, and
       * re-picking is the one thing that overwrites it.
       *
       * By length, not by rehashing. The length is already in the key (see
       * `hashBytes`), so this costs nothing, and every way a row goes wrong —
       * a truncated write, a substituted body — changes it.
       */
      const want = lengthFromHash(hash);
      if (want == null || local.byteLength === want) return local;
      // Drop it rather than leaving it to fail the same way next launch.
      await deleteDocBytes(hash).catch(() => {});
    }
  } catch {
    /* unreadable row — try the hub before giving up */
  }
  if (!remote) return null;
  try {
    const bytes = await remote(hash);
    if (!bytes || bytes.byteLength === 0) return null;
    /*
     * The key is the content hash, so the hub's answer can be checked against
     * what was asked for. Without this a short or wrong body is cached into
     * IndexedDB and every later open reads the bad copy back — the reader ends
     * up re-picking the file to fix a row the app poisoned itself.
     */
    if (await hashBytesCooperative(bytes) !== hash) return null;
    await putDocBytes(hash, bytes).catch(() => {});
    return bytes;
  } catch {
    return null;
  }
}

const IDB_RETRY_MS = [0, 150, 400] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read the local row a few times before asking the hub, and before telling
 * the reader the file is gone.
 *
 * A write that just landed can miss the first `get` on WebView. Three local
 * tries, hub only on the last.
 */
export async function loadBinaryDocBytesWithRetry(
  hash: string,
  remote?: (hash: string) => Promise<ArrayBuffer | null>,
): Promise<ArrayBuffer | null> {
  if (!hash) return null;
  const last = IDB_RETRY_MS.length - 1;
  for (let i = 0; i < IDB_RETRY_MS.length; i += 1) {
    const wait = IDB_RETRY_MS[i]!;
    if (wait > 0) await sleep(wait);
    const got = await loadBinaryDocBytes(hash, i === last ? remote : undefined);
    if (got) return got;
  }
  return null;
}

export async function deleteDocBytes(hash: string): Promise<void> {
  await run(STORE, "readwrite", (store) => store.delete(hash));
}

/** What a sweep of the byte store found, and what it did about it. */
export interface DocBytesAudit {
  /** Rows in the store when the sweep started. */
  rows: number;
  /** Rows whose bytes are not the document their key names. */
  bad: number;
  /** Rows removed — equal to `bad` for a repair, `rows` for a clear. */
  removed: number;
  /** Total bytes the store held when the sweep started. */
  bytes: number;
  /** Bytes freed by what was removed. */
  freed: number;
}

/**
 * Check every stored document against its own key, and optionally drop the
 * ones that fail.
 *
 * {@link loadBinaryDocBytes} repairs a row lazily, when someone opens that
 * document. That is the right moment for the reader — but it leaves a device
 * that was poisoned in bulk (a sync ping filling the store from a hub that was
 * answering with error bodies) carrying rows nobody has touched yet, and no way
 * to see how many. This is the sweep: it answers "is this device still holding
 * bad copies" without opening anything.
 *
 * `repair` deletes only rows that fail the check, so good copies are kept and
 * nothing has to be picked again. Clearing everything is
 * {@link clearDocBytes}, and costs re-picking each file.
 */
export async function auditDocBytes(opts?: { repair?: boolean }): Promise<DocBytesAudit> {
  const keys = await run<IDBValidKey[]>(STORE, "readonly", (store) => store.getAllKeys());
  const audit: DocBytesAudit = {
    rows: keys.length,
    bad: 0,
    removed: 0,
    bytes: 0,
    freed: 0,
  };
  for (const key of keys) {
    if (typeof key !== "string") continue;
    let size: number | null = null;
    try {
      const value = await run<unknown>(STORE, "readonly", (store) => store.get(key));
      const bytes = await bytesFromStoredValue(value);
      // An unreadable row counts as bad: it cannot serve the document either.
      size = bytes ? bytes.byteLength : 0;
      audit.bytes += size;
      if (bytes && bytesMatchDocHash(key, bytes)) continue;
    } catch {
      size = size ?? 0;
    }
    audit.bad += 1;
    if (!opts?.repair) continue;
    try {
      await deleteDocBytes(key);
      audit.removed += 1;
      audit.freed += size ?? 0;
    } catch {
      /* leave it; the next sweep tries again */
    }
  }
  return audit;
}

/**
 * Drop every stored document copy.
 *
 * The blunt instrument, and it throws nothing away that cannot come back: the
 * annotations live in the library keyed by content hash, and re-picking the
 * same file restores them. Use {@link auditDocBytes} with `repair` first — it
 * keeps the copies that are fine.
 */
export async function clearDocBytes(): Promise<DocBytesAudit> {
  const before = await auditDocBytes();
  await run(STORE, "readwrite", (store) => store.clear());
  return { ...before, removed: before.rows, freed: before.bytes };
}

/** What the document store actually is on this device, and whether it works. */
export interface DocStoreReport {
  db: string;
  version: number;
  /** Row counts per object store — proves whether the database is empty at all. */
  stores: { name: string; rows: number }[];
  /** `null` when a write survived a round trip; otherwise why it did not. */
  writeFailure: string | null;
  rows: number;
  bytes: number;
  /** Library entries that need bytes, and how many of them have none. */
  wanted: number;
  missing: number;
  /** Names of the first few documents with no stored copy. */
  missingNames: string[];
}

/**
 * Prove whether this device can store a document at all.
 *
 * An empty `bytes` store reads the same as a healthy one that nobody has used,
 * and the difference decides everything: if writes are failing, then no repair
 * helps, re-picking the file cannot stick, and the hub becomes the only source
 * a document can come from — which is exactly how a bad hub answer reaches the
 * reader on a device whose cache never holds anything.
 *
 * So this does not infer. It writes a known buffer, reads it back, compares it,
 * and deletes it, reporting whatever went wrong verbatim. `run` waits on the
 * *transaction*, so a quota abort after a successful request is caught here
 * rather than being reported as a write that landed.
 */
export async function inspectDocStore(): Promise<DocStoreReport> {
  const db = await openDb();
  const names = Array.from(db.objectStoreNames);
  const stores: { name: string; rows: number }[] = [];
  for (const name of names) {
    try {
      const rows = await run<number>(name, "readonly", (store) => store.count());
      stores.push({ name, rows });
    } catch {
      stores.push({ name, rows: -1 });
    }
  }
  const audit = await auditDocBytes();

  // 64 KB, not a handful of bytes: a quota refusal and a structured-clone
  // failure both need something with mass before they show up.
  const probe = new Uint8Array(64 * 1024);
  for (let i = 0; i < probe.length; i += 1) probe[i] = (i * 31) & 0xff;
  const key = hashBytes(probe.buffer);
  let writeFailure: string | null = null;
  try {
    await putDocBytes(key, probe.buffer);
    const back = await getDocBytes(key);
    if (!back) writeFailure = "the row was written but read back as missing";
    else if (back.byteLength !== probe.length) {
      writeFailure = `written ${probe.length} bytes, read back ${back.byteLength}`;
    } else {
      const seen = new Uint8Array(back);
      const at = probe.findIndex((value, i) => seen[i] !== value);
      if (at >= 0) writeFailure = `the bytes came back changed, first at offset ${at}`;
    }
  } catch (cause) {
    writeFailure = cause instanceof Error ? cause.message : String(cause);
  }
  await deleteDocBytes(key).catch(() => {});

  /*
   * Reconcile the library against the store.
   *
   * The counts above say what the store holds; this says what the reader is
   * actually missing, which is the number that matches their experience. An
   * entry with a binary docType and no bytes is exactly the document that
   * answers "still in the library, but this app no longer has its copy" —
   * and a device where *every* such entry is missing did not lose them one at
   * a time, it never received them.
   */
  let wanted = 0;
  let missing = 0;
  const missingNames: string[] = [];
  try {
    const { listAnnotateDocs } = await import("./annotateStore");
    const seen = new Set<string>();
    for (const entry of listAnnotateDocs()) {
      if (entry.docType !== "pdf" && entry.docType !== "epub") continue;
      if (!entry.hash || seen.has(entry.hash)) continue;
      seen.add(entry.hash);
      wanted += 1;
      if (await hasDocBytes(entry.hash)) continue;
      missing += 1;
      if (missingNames.length < 3) missingNames.push(entry.name);
    }
  } catch {
    /* library unreadable — the store numbers still stand on their own */
  }

  return {
    db: db.name,
    version: db.version,
    stores,
    writeFailure,
    rows: audit.rows,
    bytes: audit.bytes,
    wanted,
    missing,
    missingNames,
  };
}

export async function hasDocBytes(hash: string): Promise<boolean> {
  const key = await run<IDBValidKey | undefined>(STORE, "readonly", (store) =>
    store.getKey(hash),
  );
  return key != null;
}

/**
 * Content hash of a binary document.
 *
 * FNV-1a over the bytes, for the same reason `hashMarkdown` uses it over the
 * text: this answers "is this the file I annotated last time", and the
 * alternative to a cheap wrong answer is SHA-256 over 40 MB on the main thread
 * every time a book is opened. Length is mixed into the label so two files that
 * collide in 32 bits still have to be the same size to be confused.
 */
/**
 * The byte length a content hash was made from.
 *
 * {@link hashBytes} puts the length in the key on purpose — it is what makes a
 * 32-bit collision need a matching size to be confused. It is also, read back
 * out, a free integrity check on anything claiming to be that document.
 *
 * Null for a key this build did not write, so an old or foreign key is left
 * alone rather than treated as a mismatch.
 */
export function lengthFromHash(hash: string): number | null {
  if (!hash.startsWith("bin")) return null;
  const dash = hash.lastIndexOf("-");
  if (dash < 0) return null;
  const tail = hash.slice(dash + 1);
  if (!/^[0-9a-z]+$/.test(tail)) return null;
  const length = Number.parseInt(tail, 36);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

export function hashBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bin${hash.toString(36)}-${view.length.toString(36)}`;
}

/** Same digest as {@link hashBytes}, yielding so a textbook does not freeze scroll. */
export async function hashBytesCooperative(bytes: ArrayBuffer): Promise<string> {
  if (isCameraBusy()) return "";
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  const yieldEvery = 128 * 1024;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
    if (i > 0 && i % yieldEvery === 0) {
      if (isCameraBusy()) return "";
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (isCameraBusy()) return "";
    }
  }
  return `bin${hash.toString(36)}-${view.length.toString(36)}`;
}
