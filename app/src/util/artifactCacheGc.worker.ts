/**
 * The attachment cache's collection, off the main thread.
 *
 * Finding what is still referenced means reading every document, board,
 * snapshot and queued job — seconds of decoding on a tablet. Here it costs
 * the reader nothing, and it reads in short read-only batches so the app's own
 * saves are never kept waiting behind it. The deletes happen in one short
 * transaction that checks each candidate again, so a copy opened while the
 * scan ran is kept.
 */
import { openDb, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE } from "./idb";
import {
  ARTIFACT_CACHE_DELETE_LIMIT,
  artifactCachePins,
  artifactCopyExpired,
  isArtifactAssetKey,
  type CachedAssetTimes,
} from "./artifactCachePins";

/** Rows per read-only transaction. */
const BATCH = 25;

export interface ArtifactGcRequest {
  now: number;
  /** Queued sync jobs still only in memory: they pin too. */
  pending: unknown[];
}

export type ArtifactGcReply = { removed: number } | { error: string };

function readBatch(
  db: IDBDatabase,
  name: string,
  after: IDBValidKey | null,
): Promise<{ rows: Array<{ key: IDBValidKey; value: unknown }>; last: IDBValidKey | null }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const range = after === null ? null : IDBKeyRange.lowerBound(after, true);
    const request = tx.objectStore(name).openCursor(range);
    const rows: Array<{ key: IDBValidKey; value: unknown }> = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= BATCH) return;
      rows.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    tx.oncomplete = () => resolve({ rows, last: rows.length > 0 ? rows[rows.length - 1]!.key : null });
    tx.onabort = () => reject(tx.error ?? new Error("attachment cache scan aborted"));
  });
}

export async function collectInWorker({ now, pending }: ArtifactGcRequest): Promise<number> {
  const db = await openDb();
  const roots: unknown[] = [...pending];
  const assets: Array<{ key: IDBValidKey; row: CachedAssetTimes }> = [];
  for (const name of [STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE]) {
    let after: IDBValidKey | null = null;
    for (;;) {
      const { rows, last } = await readBatch(db, name, after);
      for (const { key, value } of rows) {
        if (name === STORE_CONTENT && isArtifactAssetKey(key)) assets.push({ key, row: value as CachedAssetTimes });
        else roots.push(value);
      }
      if (rows.length < BATCH || last === null) break;
      after = last;
    }
  }
  // Unknown roots or drafts throw: keep everything.
  const pins = artifactCachePins(roots);
  const candidates = assets.filter(({ key, row }) => artifactCopyExpired(key, row, pins, now)).slice(0, ARTIFACT_CACHE_DELETE_LIMIT);
  if (candidates.length === 0) return 0;
  return new Promise((resolve, reject) => {
    let removed = 0;
    const tx = db.transaction(STORE_CONTENT, "readwrite");
    const store = tx.objectStore(STORE_CONTENT);
    for (const { key } of candidates) {
      const read = store.get(key);
      read.onsuccess = () => {
        // Looked at again inside the write: used since the scan means kept.
        if (artifactCopyExpired(key, read.result as CachedAssetTimes | undefined, pins, now)) {
          store.delete(key);
          removed++;
        }
      };
    }
    tx.oncomplete = () => resolve(removed);
    tx.onabort = () => reject(tx.error ?? new Error("attachment cache cleanup aborted"));
  });
}

self.onmessage = (event: MessageEvent<ArtifactGcRequest>) => {
  collectInWorker(event.data).then(
    (removed) => self.postMessage({ removed } satisfies ArtifactGcReply),
    (cause: unknown) => self.postMessage({ error: cause instanceof Error ? cause.message : String(cause) } satisfies ArtifactGcReply),
  );
};
