/**
 * The one IndexedDB connection, and the four operations anything needs from it.
 *
 * This was `docBytes`'s private plumbing until board content needed the same
 * store. Splitting it out is not a tidy-up: the two must share a connection and
 * a version number, because two `indexedDB.open` calls at different versions
 * against the same database deadlock — the second blocks on the first, which is
 * held open for the life of the tab.
 *
 * Why any of this rather than `localStorage`:
 *
 *   - **Room.** ~5 MB of UTF-16 against hundreds of MB, and the annotation
 *     library was already exceeding the smaller number by design.
 *   - **Shape.** Structured clone stores a `Blob` by reference and a typed
 *     array natively; JSON turns the first into base64 (×1.37, then ×2 for
 *     UTF-16) and the second into `{"0":…,"1":…}`.
 *   - **Granularity.** `localStorage` holds one key per library, so changing
 *     one entry re-serialises all thirty — on a three-second timer, on the main
 *     thread, while someone is writing with a stylus.
 *   - **Honesty.** A write can report that it failed. That is the whole of
 *     `tx.onabort` below, and it is the reason this file exists at all.
 */

const DB_NAME = "lc.docs";

/**
 * Bumped from 3 when per-page ink shards moved in beside rolling snapshots.
 *
 * `onupgradeneeded` is additive and guarded per store, so an existing database
 * gains the new stores and keeps everything already in `bytes`.
 */
const DB_VERSION = 4;

/** Binary documents — PDF and EPUB bytes, keyed by content hash. */
export const STORE_BYTES = "bytes";
/** Entry content: the board blob, the source copy, the footnotes. Keyed by entry id. */
export const STORE_CONTENT = "content";
/** Rolling 2h / 24h / 7d copies of a pad. Keyed by `kind:key:tier`. */
export const STORE_SNAPSHOTS = "snapshots";
/** Per-page encoded ink WAL / archive. Keyed by `docKey\\x1fpageId`. */
export const STORE_INK_PAGES = "ink_pages";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  const existing = dbPromise;
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this device has no IndexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BYTES)) db.createObjectStore(STORE_BYTES);
      if (!db.objectStoreNames.contains(STORE_CONTENT)) db.createObjectStore(STORE_CONTENT);
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS);
      if (!db.objectStoreNames.contains(STORE_INK_PAGES)) db.createObjectStore(STORE_INK_PAGES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("could not open the document store"));
    /*
     * Another tab holding the old version open.
     *
     * `onblocked` fires and then nothing else ever does — no success, no error
     * — so without this the promise hangs forever and every save behind it
     * hangs with it. Rejecting lets the caller fall back to localStorage and
     * try again on the next save, by which time the other tab has usually
     * moved on.
     */
    request.onblocked = () =>
      reject(new Error("another tab is holding an older version of the document store"));
  }).catch((cause: unknown) => {
    // A failed open must not poison every later call — the next one retries.
    dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

/**
 * Run one request in its own transaction, and wait for the *transaction*.
 *
 * The bug this exists to not have: resolving on `request.onsuccess` alone.
 * A `readwrite` transaction can abort **after** its request succeeded — which
 * is exactly how IndexedDB reports running out of quota — so the old version
 * resolved as success on a write that never landed. Every silent-loss path in
 * this app has had that shape, and anything layered on the store would have
 * inherited one more.
 */
export function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = work(tx.objectStore(storeName));
        let result: T;
        let settled = false;
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () =>
          fail(request.error ?? new Error("the document store refused the request"));
        // A read commits with nothing to lose, so it could resolve earlier —
        // but going through the same gate keeps one code path for both, and
        // "the read completed" is not a weaker claim for waiting.
        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        tx.onabort = () =>
          fail(tx.error ?? new Error("the document store ran out of room"));
        tx.onerror = () => fail(tx.error ?? new Error("the document store failed"));
      }),
  );
}

/**
 * Several requests in one transaction — per-page WAL flushes more than one key.
 *
 * Still waits on `tx.oncomplete`, not on the last request's success, for the
 * same quota reason {@link run} exists.
 */
export function withStore(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let settled = false;
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        try {
          work(tx.objectStore(storeName));
        } catch (cause) {
          fail(cause);
          return;
        }
        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        tx.onabort = () => fail(tx.error ?? new Error("the document store ran out of room"));
        tx.onerror = () => fail(tx.error ?? new Error("the document store failed"));
      }),
  );
}

/** Is there a usable IndexedDB here? Resolves rather than throwing. */
export async function idbAvailable(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}
