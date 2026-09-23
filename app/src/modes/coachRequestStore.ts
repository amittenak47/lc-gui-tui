/** Full prepared payloads live outside localStorage; transcript stores only IDs. */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("lc-coach-requests", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("requests");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export async function saveCoachRequest(id: string, payload: unknown): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("requests", "readwrite");
    tx.objectStore("requests").put(payload, id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function loadCoachRequest<T>(id: string): Promise<T | undefined> {
  const db = await database();
  try { return await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction("requests").objectStore("requests").get(id);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}

export async function requireCoachRequest<T>(id: string): Promise<T> {
  const request = await loadCoachRequest<T>(id);
  if (request === undefined) throw new Error("Original request is unavailable. Send a new question with the document open.");
  return request;
}
