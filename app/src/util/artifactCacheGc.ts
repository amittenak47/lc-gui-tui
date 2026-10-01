import { openDb, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE } from "./idb";
import { contentSpillOnly } from "./contentStore";
import {
  ARTIFACT_CACHE_DELETE_LIMIT,
  artifactCachePins,
  artifactCopyExpired,
  isArtifactAssetKey,
  type CachedAssetTimes,
} from "./artifactCachePins";
import type { ArtifactGcReply, ArtifactGcRequest } from "./artifactCacheGc.worker";
import { waitWhileCameraBusy, yieldToIdle } from "./cameraBusy";

export { ARTIFACT_CACHE_RETENTION_MS, artifactCachePins } from "./artifactCachePins";

/** A collection still running after this is given up on; nothing is lost by stopping. */
const WORKER_TIMEOUT_MS = 120_000;

/**
 * Delete old, acknowledged cache copies that nothing refers to.
 *
 * Runs in a worker when there is one, once the camera is still and the main
 * thread idle; the walk it needs is seconds of decoding on a tablet. Without a
 * worker it falls back to the in-thread walk below.
 */
export async function collectArtifactCache(now = Date.now(), pending: unknown[] = []): Promise<number> {
  if (contentSpillOnly()) return 0;
  if (typeof Worker === "function") {
    await waitWhileCameraBusy();
    await yieldToIdle();
    const started = performance.now();
    try {
      const removed = await collectWithWorker({ now, pending });
      logCollection("worker", removed, started);
      return removed;
    } catch (cause) {
      // A worker that will not start or answer: do it here instead.
      console.info("[lc:gc] worker failed, collecting in the page", cause instanceof Error ? cause.message : cause);
    }
  }
  const started = performance.now();
  const removed = await collectInThread(now, pending);
  logCollection("page", removed, started);
  return removed;
}

function logCollection(where: "worker" | "page", removed: number, started: number): void {
  console.info(`[lc:gc] attachment cache: ${removed} cop${removed === 1 ? "y" : "ies"} removed in ${Math.round(performance.now() - started)} ms (${where})`);
}

function collectWithWorker(request: ArtifactGcRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./artifactCacheGc.worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("attachment cache collection timed out"));
    }, WORKER_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<ArtifactGcReply>) => {
      done();
      if ("removed" in event.data) resolve(event.data.removed);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message || "attachment cache worker failed"));
    };
    worker.postMessage(request);
  });
}

/** One transaction sees all roots and deletes only old, acknowledged cache copies. */
function collectInThread(now: number, pending: unknown[]): Promise<number> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const names = [STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE];
    const tx = db.transaction(names, "readwrite");
    const roots: unknown[] = [...pending];
    const assets: Array<{ key: IDBValidKey; row: CachedAssetTimes }> = [];
    let remaining = names.length, removed = 0;
    for (const name of names) {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (name === STORE_CONTENT && isArtifactAssetKey(cursor.key)) assets.push({ key: cursor.key, row: cursor.value });
          else roots.push(cursor.value);
          cursor.continue();
        } else if (--remaining === 0) {
          try {
            const pins = artifactCachePins(roots);
            for (const { key, row } of assets) {
              if (removed >= ARTIFACT_CACHE_DELETE_LIMIT) break;
              if (artifactCopyExpired(key, row, pins, now)) {
                tx.objectStore(STORE_CONTENT).delete(key);
                removed++;
              }
            }
          } catch { /* Unknown roots/drafts: retain everything. */ }
        }
      };
    }
    tx.oncomplete = () => resolve(removed);
    tx.onabort = () => reject(tx.error ?? new Error("Attachment cache cleanup failed."));
    tx.onerror = () => {};
  }));
}
