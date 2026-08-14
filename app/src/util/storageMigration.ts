/**
 * One-shot boot copy of pre-rename storage onto `whiteboard.*`.
 *
 * localStorage first (cheap, synchronous), then IndexedDB `lc.docs` →
 * `whiteboard.docs`. The marker is written only after both succeed so a
 * crashed textbook copy retries instead of leaving the writer with an empty
 * library. Failures leave the old database in place.
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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
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

async function migrateDocsDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  if (!(await databaseExists(LEGACY_DB_NAME))) return;

  const src = await openVersionedDb(LEGACY_DB_NAME, DB_VERSION);
  let dst: IDBDatabase | null = null;
  try {
    dst = await openVersionedDb(DB_NAME, DB_VERSION);
    for (const storeName of STORES) {
      if (!src.objectStoreNames.contains(storeName)) continue;
      if (!dst.objectStoreNames.contains(storeName)) continue;
      const readTx = src.transaction(storeName, "readonly");
      const readStore = readTx.objectStore(storeName);
      const keys = (await requestToPromise(readStore.getAllKeys())) as IDBValidKey[];
      const values = await requestToPromise(readStore.getAll());
      await waitTx(readTx);
      if (keys.length === 0) continue;
      const writeTx = dst.transaction(storeName, "readwrite");
      const writeStore = writeTx.objectStore(storeName);
      for (let i = 0; i < keys.length; i += 1) {
        const rawKey = keys[i];
        const value = storeName === STORE_SNAPSHOTS ? rewriteSnapshotRecord(values[i]) : values[i];
        const destKey =
          storeName === STORE_SNAPSHOTS && typeof rawKey === "string"
            ? rewriteSnapshotKey(rawKey)
            : rawKey;
        writeStore.put(value, destKey);
      }
      await waitTx(writeTx);
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
 * Copy `lc.*` / `lc.docs` onto `whiteboard.*`. Idempotent after the marker.
 *
 * Call once before pairing, the library, or IndexedDB reads.
 */
export async function migrateWhiteboardStorage(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  try {
    if (localStorage.getItem(MIGRATED_MARKER) === "1") return;
  } catch {
    return;
  }

  migrateLocalStorageKeys();
  try {
    await migrateDocsDatabase();
  } catch {
    return;
  }
  deleteMigratedLocalStorageKeys();
  try {
    localStorage.setItem(MIGRATED_MARKER, "1");
  } catch {
    /* private browsing — copy already happened this session */
  }
}
