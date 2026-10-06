import { abortTransaction, run, STORE_SYNC_STATE } from "./idb";
import { seedSyncState, syncStateKey, type PadKind, type SyncState } from "./syncStateTypes";
export * from "./syncStateTypes";

/** Allocate a range once per transaction; parallel counter reads are unsafe. */
export function allocateChangeSeqRange(tx: IDBTransaction, count: number, ready: (first: number) => void): void {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid local sequence allocation.");
  const store = tx.objectStore(STORE_SYNC_STATE);
  const request = store.get("__seq");
  request.onsuccess = () => {
    const previous = request.result as { value?: unknown } | undefined;
    const value = previous?.value === undefined ? 1 : previous.value;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value + count)) {
      abortTransaction(tx, new Error("The local change counter is invalid or exhausted."));
      return;
    }
    store.put({ value: value + count }, "__seq");
    try { ready(value + 1); } catch (cause) { abortTransaction(tx, cause); }
  };
}

/** Used by direct ink/content transactions; no cached metadata is consulted. */
export function markBookAuthored(tx: IDBTransaction, kind: PadKind, id: string, seq: number): void {
  const store = tx.objectStore(STORE_SYNC_STATE);
  const key = syncStateKey(kind, id);
  const request = store.get(key);
  request.onsuccess = () => {
    const state = (request.result as SyncState | undefined) ?? seedSyncState(kind, id);
    store.put({ ...state, changeSeq: Math.max(state.changeSeq, seq) }, key);
  };
}

export async function getBookSyncState(kind: PadKind, id: string): Promise<SyncState | null> {
  return await run<SyncState | undefined>(STORE_SYNC_STATE, "readonly", store => store.get(syncStateKey(kind, id))) ?? null;
}

export function syncStateNeedsWork(state: SyncState): boolean {
  return state.bootstrap || state.changeSeq !== state.syncedChangeSeq || state.lifecycle !== null || state.lastAttempt !== null;
}
