/**
 * Tiny filmstrip JPEGs, keyed by document content hash then page.
 *
 * A separate database from `whiteboard.docs`. Bumping that one while the tab
 * still holds v7 open deadlocks the second `indexedDB.open`. Thumbs are not
 * document bytes — they can live on their own version clock.
 */

export const PDF_THUMB_DB = "whiteboard.pdfThumbs";
export const PDF_THUMB_DB_VERSION = 1;
export const PDF_THUMB_STORE = "thumbs";

let dbPromise: Promise<IDBDatabase> | null = null;

function thumbKey(hash: string, page: number): string {
  return `${hash}\x1f${page}`;
}

function openThumbDb(): Promise<IDBDatabase> {
  const existing = dbPromise;
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this device has no IndexedDB"));
      return;
    }
    const request = indexedDB.open(PDF_THUMB_DB, PDF_THUMB_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PDF_THUMB_STORE)) {
        db.createObjectStore(PDF_THUMB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("could not open the PDF thumb store"));
    request.onblocked = () =>
      reject(new Error("another tab is holding an older PDF thumb store"));
  }).catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

export async function persistPdfThumb(
  hash: string,
  page: number,
  url: string,
): Promise<void> {
  if (!hash || !(page >= 1) || !url || typeof indexedDB === "undefined") return;
  try {
    const db = await openThumbDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PDF_THUMB_STORE, "readwrite");
      tx.objectStore(PDF_THUMB_STORE).put(url, thumbKey(hash, page));
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("PDF thumb write aborted"));
      tx.onerror = () =>
        reject(tx.error ?? new Error("PDF thumb write failed"));
    });
  } catch {
    /* private mode / quota */
  }
}

export async function loadStoredPdfThumbs(
  hash: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!hash || typeof indexedDB === "undefined") return out;
  try {
    const db = await openThumbDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PDF_THUMB_STORE, "readonly");
      const store = tx.objectStore(PDF_THUMB_STORE);
      const range = IDBKeyRange.bound(`${hash}\x1f`, `${hash}\x1f\uffff`);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const page = Number(String(cursor.key).slice(hash.length + 1));
        if (page >= 1 && typeof cursor.value === "string" && cursor.value) {
          out.set(page, cursor.value);
        }
        cursor.continue();
      };
      req.onerror = () =>
        reject(req.error ?? new Error("PDF thumb read failed"));
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("PDF thumb read aborted"));
    });
  } catch {
    /* private mode */
  }
  return out;
}
