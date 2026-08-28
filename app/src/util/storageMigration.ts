/**
 * One-shot boot copy of pre-rename storage onto `whiteboard.*`.
 *
 * localStorage first (cheap, synchronous), then IndexedDB `lc.docs` →
 * `whiteboard.docs`. The marker is written only after both succeed so a
 * crashed textbook copy retries instead of leaving the writer with an empty
 * library. Failures leave the old database in place.
 *
 * The IndexedDB copy goes a batch at a time, through a cursor. It used to be
 * `getAllKeys()` + `getAll()` per store, which reads every document's bytes
 * and every ink page into memory at once — a whole library, on the launch of
 * an upgrade, on a tablet. That is a peak the device may simply refuse, and
 * refusing it looked like the app dying on startup. Yielding between batches
 * also lets the shell paint, which is the other half of the fix (`main.tsx`).
 *
 * Stores are checkpointed as they finish, so a copy that is killed halfway
 * resumes rather than starting the whole library again on every launch.
 */

import {
  DB_NAME,
  DB_VERSION,
  LEGACY_DB_NAME,
  STORE_BYTES,
  STORE_CONTENT,
  STORE_INK_PAGES,
  STORE_SNAPSHOTS,
} from "./idb";
import { MIGRATED_MARKER, remapLcKey } from "./storageKeys";

const STORES = [STORE_BYTES, STORE_CONTENT, STORE_SNAPSHOTS, STORE_INK_PAGES] as const;

/** Stores already copied, so a killed migration does not start over. */
const STORES_DONE_KEY = `${MIGRATED_MARKER}.stores`;

/**
 * How much one batch may carry.
 *
 * Whichever comes first: `STORE_BYTES` rows are whole PDFs, so a handful can
 * be tens of megabytes, while ink pages are small and numerous and would spend
 * the whole migration yielding if the only limit were bytes.
 */
const BATCH_ROWS = 64;
const BATCH_BYTES = 8 * 1024 * 1024;

/** Whether the batch just filled. Exported so the limits can be checked. */
export function migrationBatchIsFull(rows: number, bytes: number): boolean {
  return rows >= BATCH_ROWS || bytes >= BATCH_BYTES;
}

/** Enough to bound a batch. Not an accounting of the heap. */
export function migrationRowSize(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (typeof value === "string") return value.length * 2;
  return 4096;
}

/** Let the browser paint, and let the transaction that just committed go. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function doneStores(): Set<string> {
  try {
    const raw = localStorage.getItem(STORES_DONE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : []);
  } catch {
    return new Set();
  }
}

function markStoreDone(name: string): void {
  try {
    const done = doneStores();
    done.add(name);
    localStorage.setItem(STORES_DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* private browsing — the copy is idempotent, it just repeats */
  }
}

function clearStoreProgress(): void {
  try {
    localStorage.removeItem(STORES_DONE_KEY);
  } catch {
    /* ignore */
  }
}

export function migrateLocalStorageKeys(storage: Storage = localStorage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key) keys.push(key);
  }
  for (const key of keys) {
    const next = remapLcKey(key);
    if (!next) continue;
    try {
      if (storage.getItem(next) == null) {
        const value = storage.getItem(key);
        if (value != null) storage.setItem(next, value);
      }
    } catch {
      /* quota — leave the old key; retry next launch */
    }
  }
}

/** Copy `whiteboard.coach.*` onto `whiteboard.agent.*` without clobbering newer dest. */
export function remapCoachStorageKeys(storage: Storage = localStorage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key) keys.push(key);
  }
  for (const key of keys) {
    if (!key.startsWith("whiteboard.coach.")) continue;
    const next = `whiteboard.agent.${key.slice("whiteboard.coach.".length)}`;
    try {
      if (storage.getItem(next) == null) {
        const value = storage.getItem(key);
        if (value != null) storage.setItem(next, value);
      }
    } catch {
      /* quota — leave the old key; retry next launch */
    }
  }
}

function deleteMigratedLocalStorageKeys(): void {
  if (typeof localStorage === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key) keys.push(key);
  }
  for (const key of keys) {
    if (remapLcKey(key)) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }
}

function openVersionedDb(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this device has no IndexedDB"));
      return;
    }
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`could not open ${name}`));
    request.onblocked = () =>
      reject(new Error(`another tab is holding ${name}`));
  });
}

function waitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
  });
}

function rewriteSnapshotKey(key: string): string {
  return key.startsWith("md-ink:") ? `annotate:${key.slice("md-ink:".length)}` : key;
}

function rewriteSnapshotRecord(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const record = row as { kind?: unknown };
  if (record.kind === "md-ink") return { ...record, kind: "annotate" };
  return row;
}

async function databaseExists(name: string): Promise<boolean> {
  const list = indexedDB.databases;
  if (typeof list !== "function") return true;
  try {
    const dbs = await list.call(indexedDB);
    return dbs.some((db) => db.name === name);
  } catch {
    return true;
  }
}

type Row = { key: IDBValidKey; value: unknown };

/**
 * One batch of rows, from just past `after`.
 *
 * A fresh read transaction per batch on purpose: an IndexedDB transaction
 * commits as soon as the task queue drains without a live request against it,
 * so it cannot be held across the yield between batches.
 */
async function readBatch(
  src: IDBDatabase,
  storeName: string,
  after: IDBValidKey | undefined,
): Promise<Row[]> {
  const tx = src.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const rows: Row[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const request =
      after === undefined
        ? store.openCursor()
        : store.openCursor(IDBKeyRange.lowerBound(after, true));
    request.onerror = () =>
      reject(request.error ?? new Error(`could not read ${storeName}`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      rows.push({ key: cursor.key, value: cursor.value });
      bytes += migrationRowSize(cursor.value);
      if (migrationBatchIsFull(rows.length, bytes)) {
        resolve();
        return;
      }
      cursor.continue();
    };
  });
  return rows;
}

async function writeBatch(
  dst: IDBDatabase,
  storeName: string,
  rows: readonly Row[],
): Promise<void> {
  const tx = dst.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  for (const row of rows) {
    const value = storeName === STORE_SNAPSHOTS ? rewriteSnapshotRecord(row.value) : row.value;
    const destKey =
      storeName === STORE_SNAPSHOTS && typeof row.key === "string"
        ? rewriteSnapshotKey(row.key)
        : row.key;
    store.put(value, destKey);
  }
  await waitTx(tx);
}

async function migrateDocsDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  if (!(await databaseExists(LEGACY_DB_NAME))) return;

  const src = await openVersionedDb(LEGACY_DB_NAME, DB_VERSION);
  let dst: IDBDatabase | null = null;
  try {
    dst = await openVersionedDb(DB_NAME, DB_VERSION);
    const done = doneStores();
    for (const storeName of STORES) {
      if (done.has(storeName)) continue;
      if (!src.objectStoreNames.contains(storeName)) continue;
      if (!dst.objectStoreNames.contains(storeName)) continue;
      let after: IDBValidKey | undefined;
      for (;;) {
        const rows = await readBatch(src, storeName, after);
        if (rows.length === 0) break;
        await writeBatch(dst, storeName, rows);
        after = rows[rows.length - 1]!.key;
        // Hand the frame back: this is running while the shell is on screen.
        await yieldToPaint();
      }
      markStoreDone(storeName);
    }
  } finally {
    src.close();
    dst?.close();
  }

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("could not drop lc.docs"));
    req.onblocked = () => resolve();
  });
}

/**
 * Copy `lc.*` / `lc.docs` onto `whiteboard.*`, then `whiteboard.coach.*` onto
 * `whiteboard.agent.*`. Idempotent after the marker reaches `"2"`.
 *
 * Call once before pairing, the library, or IndexedDB reads.
 */
export async function migrateWhiteboardStorage(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  let marker: string | null = null;
  try {
    marker = localStorage.getItem(MIGRATED_MARKER);
  } catch {
    return;
  }
  if (marker === "2") return;

  migrateLocalStorageKeys();
  if (marker !== "1") {
    try {
      await migrateDocsDatabase();
    } catch {
      return;
    }
  }
  remapCoachStorageKeys();
  deleteMigratedLocalStorageKeys();
  try {
    localStorage.setItem(MIGRATED_MARKER, "2");
  } catch {
    /* private browsing — copy already happened this session */
  }
  clearStoreProgress();
}

/**
 * Is there anything to do?
 *
 * Read synchronously so the boot path can tell, before it renders anything,
 * whether this launch is an ordinary one or an upgrade — an upgrade gets a
 * splash saying what is happening, and everybody else must not see one flash
 * past for a migration that returns immediately.
 */
export function storageMigrationPending(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(MIGRATED_MARKER) !== "2";
  } catch {
    return false;
  }
}
