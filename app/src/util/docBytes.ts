/**
 * The bytes of a binary document, kept where bytes can actually live.
 *
 * Markdown annotation sets carry a copy of their source in the library JSON,
 * which works because a note is a few kilobytes of text. A textbook PDF is
 * tens of megabytes, and `localStorage` is a synchronous string store with a
 * quota around five — putting a PDF through it would be a base64 round trip on
 * the main thread that fails a third of the way in. IndexedDB takes a `Blob`
 * as-is, off the main thread, with no encoding.
 *
 * Keyed by content hash, exactly like the annotations that go with it. That is
 * what makes reopening a file from the library work without ever having known
 * where on disk it came from, and it is also why two copies of the same
 * textbook in two folders cost one entry rather than two.
 */

const DB_NAME = "lc.docs";
const DB_VERSION = 1;
const STORE = "bytes";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  const existing = dbPromise;
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("this device has no IndexedDB — PDF and EPUB need it"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("could not open the document store"));
  }).catch((cause: unknown) => {
    // A failed open must not poison every later call — the next one retries.
    dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("the document store refused the request"));
      }),
  );
}

export async function putDocBytes(hash: string, bytes: ArrayBuffer): Promise<void> {
  // Stored as a Blob rather than an ArrayBuffer: structured clone of a Blob is
  // a reference, so a 40 MB textbook is not copied through memory on save.
  await run("readwrite", (store) => store.put(new Blob([bytes]), hash));
}

export async function getDocBytes(hash: string): Promise<ArrayBuffer | null> {
  const value = await run<Blob | ArrayBuffer | undefined>("readonly", (store) =>
    store.get(hash),
  );
  if (!value) return null;
  return value instanceof Blob ? await value.arrayBuffer() : value;
}

export async function deleteDocBytes(hash: string): Promise<void> {
  await run("readwrite", (store) => store.delete(hash));
}

export async function hasDocBytes(hash: string): Promise<boolean> {
  const key = await run<IDBValidKey | undefined>("readonly", (store) =>
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
export function hashBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bin${hash.toString(36)}-${view.length.toString(36)}`;
}
