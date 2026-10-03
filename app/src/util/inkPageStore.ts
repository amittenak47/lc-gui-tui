/**
 * Per-page encoded ink in IndexedDB — the dirty WAL and the optional gzip archive.
 *
 * Live autosave used to `encodeInkOps` the whole book into `content.board.inkC`.
 * A 1500-page dense textbook is tens of MB of typed arrays cloned on a 3s
 * timer. This store writes only the pages that changed, as structured-clone
 * `EncodedInk` (not JSON, not localStorage). Page 0 is the spanning shard.
 *
 * `content.board.inkC` stays readable for old entries and for snapshots; new
 * live saves prefer these keys and keep a manifest on the blob.
 */

import {
  lazyEncodedInk,
  summarizeEncodedInk,
  unpackEncodedInk,
  type EncodedInk,
  type InkPageSummary,
} from "../canvas/inkCodec";
import { bytesFromMaybeGzip } from "./gzip";
import { run, STORE_INK_PAGES, withStore } from "./idb";

const KEY_SEP = "\u001f";

export interface InkPageRecord {
  v: 1;
  docKey: string;
  pageId: number;
  /** Uncompressed WAL. Present while dirty, or on devices that never gzipped. */
  inkC?: EncodedInk;
  /** Worker-gzipped {@link packEncodedInk} bytes. */
  gz?: Uint8Array<ArrayBuffer>;
  dirty: boolean;
  updatedAt: number;
  /** Authored revision last exchanged with the hub (independent of gzip/save). */
  syncedUpdatedAt?: number;
  /**
   * A PDF page that came from the hub before this device could place it in
   * its own layout (page sizes not known yet). See `localizePendingPdfInk`.
   */
  layoutPending?: boolean;
  /**
   * The archive's {@link InkPageSummary}, so opening needs to unpack only the
   * pages read. Stamped with the archive's length: a row whose `gz` was
   * replaced without it reads as having none.
   */
  sum?: StoredInkSummary;
}

interface StoredInkSummary extends InkPageSummary {
  v: 1;
  len: number;
}

function storedSummary(row: InkPageRecord): InkPageSummary | null {
  const sum = row.sum;
  if (!sum || sum.v !== 1 || !row.gz || sum.len !== row.gz.byteLength) return null;
  return sum;
}

/**
 * Ink for one annotation set.
 *
 * Keyed by the sidecar's library id, not by the hash of the file it was drawn
 * over. Two annotation sets on one PDF are two ids and one hash; keying on the
 * hash meant they shared these rows, so the second set's strokes landed on top
 * of the first set's. The id is minted when the document opens, before anything
 * is saved, so ink written in the first few seconds still has somewhere of its
 * own to go. See `migrateAnnotateKeysToId` in `annotateStore` for the rows
 * written by the build that keyed these on the hash.
 */
export function annotateDocKey(sidecarId: string): string {
  return `md:${sidecarId}`;
}

export function whiteboardDocKey(id: string): string {
  return `wb:${id}`;
}

/** Session ink for a footnote-owned scratch board — not the PDF's `md:` pages. */
export function footnoteWhiteboardDocKey(docId: string, wbId: string): string {
  return `fnwb:${docId}:${wbId}`;
}

export function inkPageKey(docKey: string, pageId: number): string {
  return `${docKey}${KEY_SEP}${pageId}`;
}

export function inkPageKeyRange(docKey: string): IDBKeyRange {
  return IDBKeyRange.bound(`${docKey}${KEY_SEP}`, `${docKey}${KEY_SEP}\uffff`);
}

function isRecord(value: unknown): value is InkPageRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as InkPageRecord;
  return row.v === 1 && typeof row.docKey === "string" && typeof row.pageId === "number";
}

export async function encodedFromRecord(row: InkPageRecord): Promise<EncodedInk | null> {
  if (row.inkC) return row.inkC;
  if (!row.gz) return null;
  try {
    // Gunzipped natively (off the main thread where the WebView can), then
    // unpacked here. The archive worker took longer to start and to hand a
    // book's 17 MB of points back than the unpacking itself costs.
    return unpackEncodedInk(await bytesFromMaybeGzip(row.gz));
  } catch {
    return null;
  }
}

/**
 * Promote dirty WAL → gzip archive only if this is still the row we listed.
 *
 * A stroke that landed while the worker was compressing must keep its newer
 * `inkC`. Overwriting it with the gzip of the previous save would drop ink.
 */
export function shouldPromoteToArchive(
  existing: InkPageRecord | null | undefined,
  expectedUpdatedAt: number,
): boolean {
  if (!existing?.dirty || !existing.inkC) return false;
  return existing.updatedAt === expectedUpdatedAt;
}

export async function getInkPageRecord(
  docKey: string,
  pageId: number,
): Promise<InkPageRecord | null> {
  try {
    const row = await run<InkPageRecord | undefined>(
      STORE_INK_PAGES,
      "readonly",
      (store) => store.get(inkPageKey(docKey, pageId)),
    );
    return row && isRecord(row) ? row : null;
  } catch {
    return null;
  }
}

export async function putInkPages(
  docKey: string,
  pages: Map<number, EncodedInk> | Iterable<[number, EncodedInk]>,
  opts?: { dirty?: boolean; now?: number },
): Promise<void> {
  const dirty = opts?.dirty !== false;
  const now = opts?.now ?? Date.now();
  const entries = [...pages];
  if (entries.length === 0) return;
  await withStore(STORE_INK_PAGES, "readwrite", (store) => {
    for (const [pageId, inkC] of entries) {
      const key = inkPageKey(docKey, pageId);
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result as InkPageRecord | undefined;
        const row: InkPageRecord = {
          v: 1, docKey, pageId, inkC, dirty,
          updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + 1),
          ...(existing?.syncedUpdatedAt != null
            ? { syncedUpdatedAt: existing.syncedUpdatedAt } : {}),
        };
        store.put(row, key);
      };
    }
  });
}

export async function putInkPageArchive(
  docKey: string,
  pageId: number,
  gz: Uint8Array<ArrayBuffer>,
  expectedUpdatedAt: number,
): Promise<boolean> {
  let promoted = false;
  await withStore(STORE_INK_PAGES, "readwrite", (store) => {
    const key = inkPageKey(docKey, pageId);
    const request = store.get(key);
    request.onsuccess = () => {
      const existing = request.result as InkPageRecord | undefined;
      if (!shouldPromoteToArchive(existing, expectedUpdatedAt)) return;
      // Compare and replace in one transaction. Compression changes storage,
      // not the authored revision used by sync conflict detection.
      const { inkC: _wal, ...row } = existing!;
      store.put({ ...row, gz, dirty: false }, key);
      promoted = true;
    };
  });
  return promoted;
}

/** Remember only the revision sent; a stroke arriving during PUT stays unsynced. */
export async function markInkPageSynced(
  docKey: string, pageId: number, updatedAt: number,
): Promise<void> {
  await withStore(STORE_INK_PAGES, "readwrite", (store) => {
    const key = inkPageKey(docKey, pageId);
    const request = store.get(key);
    request.onsuccess = () => {
      const row = request.result as InkPageRecord | undefined;
      if (!row || row.updatedAt < updatedAt || (row.syncedUpdatedAt ?? 0) > updatedAt) return;
      store.put({ ...row, syncedUpdatedAt: updatedAt }, key);
    };
  });
}

/** Let the main thread's queued work run before going on. */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function getInkPages(docKey: string): Promise<Map<number, EncodedInk>> {
  const rows = await getInkPageRecords(docKey);
  const out = new Map<number, EncodedInk>();
  // Inflated together (natively, off this thread where the WebView can)…
  const raws = await Promise.all(rows.map((row) =>
    row.inkC || !row.gz ? null : bytesFromMaybeGzip(row.gz).catch(() => null)));
  // …and unpacked only when read, for the pages whose row says what is on
  // them. Unpacking a written-in book whole held the main thread for a third
  // of a second of every open, for pages nobody had turned to yet.
  const unsummarized: [InkPageRecord, EncodedInk][] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    let encoded: EncodedInk | null = row.inkC ?? null;
    const raw = raws[i];
    if (!encoded && raw) {
      const summary = storedSummary(row);
      if (summary) {
        encoded = lazyEncodedInk(raw, summary);
      } else {
        try {
          encoded = unpackEncodedInk(raw);
        } catch {
          encoded = null;
        }
        if (encoded) unsummarized.push([row, encoded]);
        // A page at a time, letting the rest of the open in between.
        await yieldToMain();
      }
    }
    if (encoded) out.set(row.pageId, encoded);
  }
  if (unsummarized.length > 0) scheduleSummaryBackfill(docKey, unsummarized);
  return out;
}

/** Long enough after an open for its own work to be done. */
const SUMMARY_BACKFILL_DELAY_MS = 8000;
const backfilling = new Set<string>();

/**
 * Give archived rows that predate summaries one, once the book is open.
 *
 * Opening reads each such page's strokes for its bounds anyway; the summary
 * worked out then is remembered on the page, so this is mostly writing it
 * down. A row that changed since it was read is left for the next open.
 */
function scheduleSummaryBackfill(docKey: string, pages: [InkPageRecord, EncodedInk][]): void {
  if (backfilling.has(docKey)) return;
  backfilling.add(docKey);
  setTimeout(() => {
    void (async () => {
      const sums = new Map<number, { updatedAt: number; sum: StoredInkSummary }>();
      for (const [row, encoded] of pages) {
        if (!row.gz) continue;
        sums.set(row.pageId, {
          updatedAt: row.updatedAt,
          sum: { v: 1, len: row.gz.byteLength, ...summarizeEncodedInk(encoded) },
        });
        await yieldToMain();
      }
      await withStore(STORE_INK_PAGES, "readwrite", (store) => {
        for (const [pageId, { updatedAt, sum }] of sums) {
          const key = inkPageKey(docKey, pageId);
          const request = store.get(key);
          request.onsuccess = () => {
            const current = request.result as InkPageRecord | undefined;
            if (!current || current.inkC || current.updatedAt !== updatedAt) return;
            if (current.gz?.byteLength !== sum.len) return;
            store.put({ ...current, sum }, key);
          };
        }
      });
    })().catch(() => {
      /* the next open tries again */
    }).finally(() => backfilling.delete(docKey));
  }, SUMMARY_BACKFILL_DELAY_MS);
}

export async function getInkPageRecords(docKey: string, opts: { metadataOnly?: boolean; strict?: boolean; pageIds?: readonly number[] } = {}): Promise<InkPageRecord[]> {
  const rows: InkPageRecord[] = [];
  try {
    await withStore(STORE_INK_PAGES, "readonly", (store) => {
      const collect = (value: unknown) => {
        if (isRecord(value)) {
          // Sync compares clocks. Retaining every compressed/WAL payload here
          // makes even a one-page update hold an entire handwritten book.
          rows.push(opts.metadataOnly ? {
            v: value.v, docKey: value.docKey, pageId: value.pageId,
            dirty: value.dirty, updatedAt: value.updatedAt, syncedUpdatedAt: value.syncedUpdatedAt,
            ...(value.layoutPending ? { layoutPending: true } : {}),
          } : value);
        }
      };
      if (opts.pageIds) {
        // Previewing a page must not clone every other page just to filter it.
        for (const pageId of new Set(opts.pageIds)) {
          const request = store.get(inkPageKey(docKey, pageId));
          request.onsuccess = () => collect(request.result);
        }
      } else {
        const request = store.openCursor(inkPageKeyRange(docKey));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          collect(cursor.value);
          cursor.continue();
        };
      }
    });
  } catch (cause) {
    if (opts.strict) throw cause;
    return [];
  }
  return rows;
}

export async function getInkPage(docKey: string, pageId: number): Promise<EncodedInk | null> {
  const row = await getInkPageRecord(docKey, pageId);
  if (!row) return null;
  return encodedFromRecord(row);
}

export async function deleteInkPages(docKey: string): Promise<void> {
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      const request = store.openCursor(inkPageKeyRange(docKey));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
}

/** Drop every ink shard whose docKey starts with `prefix` (e.g. `fnwb:{docId}:`). */
export async function deleteInkPagesByPrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
}

/**
 * Every doc key under `prefix` that holds at least one page.
 *
 * "Which of this document's scratch boards has handwriting on it?" — asked
 * once per sync, and answerable from the key alone, so it walks keys rather
 * than reading records.
 */
export async function listInkDocKeys(prefix: string): Promise<string[]> {
  if (!prefix) return [];
  const found = new Set<string>();
  try {
    await withStore(STORE_INK_PAGES, "readonly", (store) => {
      const request = store.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        const at = key.lastIndexOf(KEY_SEP);
        if (at > 0) found.add(key.slice(0, at));
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
  return [...found].sort();
}

/**
 * Copy every page of ink from one doc key to another, leaving the original.
 *
 * For a board that has been forked: a conflict that keeps two copies of one
 * mark, or a remint that gives the incoming board a key of its own. Copying
 * the blob without the shards used to hand the new board an empty page, since
 * the strokes are no longer inside the blob to be copied with it.
 */
export async function copyInkPages(fromKey: string, toKey: string): Promise<number> {
  if (!fromKey || !toKey || fromKey === toKey) return 0;
  const rows = await getInkPageRecords(fromKey);
  if (rows.length === 0) return 0;
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      for (const row of rows) {
        store.put({ ...row, docKey: toKey }, inkPageKey(toKey, row.pageId));
      }
    });
  } catch {
    return 0;
  }
  return rows.length;
}

/**
 * Move every page of ink from one doc key to another.
 *
 * Only used by the hash-to-id migration. Copy-then-delete rather than a cursor
 * `update`: the key is part of the record's identity here, and a half-finished
 * rename that left rows under both keys would restore ink twice.
 */
export async function renameInkPages(fromKey: string, toKey: string): Promise<number> {
  const rows = await getInkPageRecords(fromKey);
  if (rows.length === 0) return 0;
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      for (const row of rows) {
        store.put({ ...row, docKey: toKey }, inkPageKey(toKey, row.pageId));
      }
    });
  } catch {
    // Nothing was moved, so leave the originals where they are and try again
    // on the next open rather than deleting ink we failed to copy.
    return 0;
  }
  await deleteInkPages(fromKey);
  return rows.length;
}

/** Leftover dirty rows from a crash — gzip drain (WAKE_UP). */
export async function listDirtyInkPages(): Promise<InkPageRecord[]> {
  const rows: InkPageRecord[] = [];
  try {
    await withStore(STORE_INK_PAGES, "readonly", (store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (isRecord(value) && value.dirty && value.inkC) rows.push(value);
        cursor.continue();
      };
    });
  } catch {
    return [];
  }
  return rows;
}
