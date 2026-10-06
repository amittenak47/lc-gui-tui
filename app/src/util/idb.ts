/** One schema and connection for every local book transaction. */
import {
  captureLegacyStorage, migrateLegacyUpgrade, revalidateLegacyStorage,
  type LegacyStorageCapture, MigrationError,
} from "./queueMigration";

export const DB_NAME = "whiteboard.docs";
export const LEGACY_DB_NAME = "lc.docs";
export const DB_VERSION = 8;
export const STORE_BYTES = "bytes";
export const STORE_CONTENT = "content";
export const STORE_SNAPSHOTS = "snapshots";
export const STORE_INK_PAGES = "ink_pages";
export const STORE_OFFLINE_BOARDS = "offline_boards";
export const STORE_PROBLEM_BOARDS = "problem_boards";
export const STORE_LINKS = "note_links";
export const STORE_SYNC_STATE = "sync_state";
export const STORE_BOOK_META = "book_meta";
export const STORE_SYNC_RECOVERY = "sync_recovery";
export const BOOK_STORES = [STORE_BYTES, STORE_CONTENT, STORE_SNAPSHOTS, STORE_INK_PAGES,
  STORE_OFFLINE_BOARDS, STORE_PROBLEM_BOARDS, STORE_LINKS, STORE_SYNC_STATE,
  STORE_BOOK_META, STORE_SYNC_RECOVERY] as const;

export class StorageUnavailableError extends Error {}
export class StorageBlockedError extends MigrationError {}
let dbPromise: Promise<IDBDatabase> | null = null;
let openGeneration = 0;
const transactionErrors = new WeakMap<IDBTransaction,unknown>();
export function abortTransaction(tx:IDBTransaction,cause:unknown):void {
  if(!transactionErrors.has(tx)) transactionErrors.set(tx,cause);
  try {tx.abort();} catch { /* a failed transaction still keeps its original cause */ }
}

/** The upgrade callback is synchronous: only live IndexedDB requests run here. */
export function initializeSchema(
  db: IDBDatabase, tx: IDBTransaction, oldVersion: number,
  capture: LegacyStorageCapture, fail: (cause: unknown) => void,
): void {
  try {
    for (const name of BOOK_STORES) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
    if (oldVersion < DB_VERSION) migrateLegacyUpgrade(db, tx, capture, fail);
  } catch (cause) { fail(cause); }
}

export function validateSchema(db: IDBDatabase): void {
  for (const name of BOOK_STORES) {
    if (!db.objectStoreNames.contains(name)) throw new MigrationError(`The library is missing its ${name} store. The original data has been retained.`);
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const generation = ++openGeneration;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new StorageUnavailableError("This device has no IndexedDB")); return;
    }
    let capture: LegacyStorageCapture;
    let request: IDBOpenDBRequest;
    try {
      capture = captureLegacyStorage();
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (cause) { reject(cause); return; }
    let settled = false;
    let originalError: unknown;
    const fail = (cause: unknown) => {
      originalError ??= cause;
      if (!settled) { settled = true; reject(originalError); }
    };
    request.onupgradeneeded = (event) => {
      if (settled) { request.transaction?.abort(); return; }
      const tx = request.transaction!;
      const abort = (cause: unknown) => {
        originalError ??= cause;
        abortTransaction(tx,cause);
      };
      initializeSchema(request.result, tx, event.oldVersion, capture, abort);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled || generation !== openGeneration) { db.close(); return; }
      db.onversionchange = () => {
        db.close();
        if (generation === openGeneration) { dbPromise = null; ++openGeneration; }
      };
      void (async () => {
        try {
          validateSchema(db);
          await revalidateLegacyStorage(db, capture);
          if (settled || generation !== openGeneration) { db.close(); return; }
          settled = true; resolve(db);
        } catch (cause) { db.close(); fail(cause); }
      })();
    };
    request.onerror = () => fail(originalError ?? request.error ?? new MigrationError("Could not initialize the library. The original data has been retained."));
    request.onblocked = () => fail(new StorageBlockedError("Another window is holding the old library open. Close that window and retry; your data has been retained."));
  }).catch((cause: unknown) => {
    if (generation === openGeneration) dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

/** Result visibility follows transaction completion, including quota failures. */
export function transactionOn<T>(
  db: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, setResult: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    let settled = false;
    let originalError: unknown;
    let tx: IDBTransaction;
    const fail = (cause: unknown) => {
      originalError ??= cause;
      if (!settled) { settled = true; reject(originalError); }
    };
    try { tx = db.transaction([...stores], mode); } catch (cause) { fail(cause); return; }
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    tx.onabort = () => fail(originalError ?? transactionErrors.get(tx) ?? tx.error ?? new Error("The library transaction was aborted"));
    tx.onerror = () => fail(originalError ?? transactionErrors.get(tx) ?? tx.error ?? new Error("The library transaction failed"));
    try {
      work(tx, value => { result = value; });
    } catch (cause) {
      originalError = cause;
      abortTransaction(tx,cause);
      fail(cause);
    }
  });
}

export function withTransaction<T>(
  stores: readonly string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, setResult: (value: T) => void) => void,
): Promise<T> {
  return openDb().then(db => transactionOn(db, stores, mode, work));
}

export function run<T>(storeName: string, mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withTransaction<T>([storeName], mode, (tx, setResult) => {
    const request = work(tx.objectStore(storeName));
    request.onsuccess = () => setResult(request.result);
    // Request failure aborts the transaction and propagates its specific error.
  });
}

export function withStore(storeName: string, mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void): Promise<void> {
  return withTransaction<void>([storeName], mode, (tx, setResult) => {
    work(tx.objectStore(storeName)); setResult(undefined);
  });
}

export async function idbAvailable(): Promise<boolean> {
  try { await openDb(); return true; } catch { return false; }
}

/** Isolated fixtures can close their handle without sharing a future factory. */
export async function closeDbForTests(): Promise<void> {
  const previous = dbPromise;
  dbPromise = null; ++openGeneration;
  if (previous) { try { (await previous).close(); } catch { /* failed open */ } }
}
