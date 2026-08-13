/**
 * Main-thread client for the ink archive worker.
 *
 * Phase 4: dirty WAL → gzip per page → archive, never under the pen.
 * `isProcessing` (`draining`) is the lock; a failed page stays dirty and is
 * skipped. Main thread only `postMessage`. If Worker is missing, pages stay
 * dirty — we do **not** gzip on this thread during drain.
 *
 * Snapshot concat uses the same worker. Tests / Node fall back to the sync
 * codec for concat only, not for the live archive drain.
 */

import InkArchiveWorker from "./inkArchive.worker.ts?worker";
import {
  concatEncodedInk,
  packEncodedInk,
  unpackEncodedInk,
  type EncodedInk,
} from "./inkCodec";
import { bytesFromMaybeGzip, gzipBytes } from "../util/gzip";
import type { InkArchiveRequest, InkArchiveResponse } from "./inkArchive.worker";

type Pending = {
  resolve: (value: InkArchiveResponse) => void;
};

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    // `?worker` is what Vite actually emits a chunk for — a `new URL` import
    // can ship no worker at all, which is how Phase 4 would silently skip.
    worker = new InkArchiveWorker();
    worker.onmessage = (event: MessageEvent<InkArchiveResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      job.resolve(event.data);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      for (const job of pending.values()) {
        job.resolve({ id: 0, ok: false, error: "ink archive worker failed" });
      }
      pending.clear();
    };
    return worker;
  } catch {
    worker = null;
    return null;
  }
}

function rpc(
  type: InkArchiveRequest["type"],
  payload: Omit<InkArchiveRequest, "id" | "type">,
): Promise<InkArchiveResponse> {
  const w = getWorker();
  const id = nextId++;
  if (!w) return Promise.resolve({ id, ok: false, error: "no worker" });
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    w.postMessage({ id, type, ...payload } as InkArchiveRequest);
  });
}

export async function concatInkShards(shards: readonly EncodedInk[]): Promise<EncodedInk> {
  if (shards.length <= 1) return shards[0] ?? { v: 2, ops: [] };
  const response = await rpc("concat", { shards: [...shards] });
  if (response.ok && response.encoded) return response.encoded;
  return concatEncodedInk(shards);
}

/** Worker gzip. Null when the worker is missing or the page failed — stay dirty. */
export async function gzipPackInWorker(
  encoded: EncodedInk,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const response = await rpc("gzipPack", { encoded });
  if (response.ok && response.bytes) return response.bytes;
  return null;
}

export async function gzipPackInk(encoded: EncodedInk): Promise<Uint8Array<ArrayBuffer>> {
  const fromWorker = await gzipPackInWorker(encoded);
  if (fromWorker) return fromWorker;
  return gzipBytes(packEncodedInk(encoded));
}

export async function gunzipUnpackInk(bytes: Uint8Array<ArrayBuffer>): Promise<EncodedInk | null> {
  const response = await rpc("gunzipUnpack", { bytes });
  if (response.ok && response.encoded) return response.encoded;
  try {
    return unpackEncodedInk(await bytesFromMaybeGzip(bytes));
  } catch {
    return null;
  }
}

export async function concatAndGzipInk(shards: readonly EncodedInk[]): Promise<{
  encoded: EncodedInk;
  bytes: Uint8Array<ArrayBuffer>;
}> {
  const response = await rpc("concatAndGzip", { shards: [...shards] });
  if (response.ok && response.encoded && response.bytes) {
    return { encoded: response.encoded, bytes: response.bytes };
  }
  const encoded = concatEncodedInk(shards);
  return { encoded, bytes: await gzipBytes(packEncodedInk(encoded)) };
}

let draining = false;
let drainAgain = false;

/**
 * Dirty → worker gzip → archive Blob, then drop the uncompressed WAL.
 *
 * Called after every dirty flush and once on boot (WAKE_UP). Does not await
 * from the pen path — enqueue and return. A page the worker cannot compress
 * stays dirty and is skipped; the next drain retries it.
 */
export async function drainDirtyInkArchives(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      const { listDirtyInkPages, putInkPageArchive } = await import("../util/inkPageStore");
      const dirty = await listDirtyInkPages();
      for (const row of dirty) {
        if (!row.inkC) continue;
        const gz = await gzipPackInWorker(row.inkC);
        if (!gz) continue;
        try {
          await putInkPageArchive(row.docKey, row.pageId, gz, row.updatedAt);
        } catch {
          /* stay dirty */
        }
      }
    } while (drainAgain);
  } finally {
    draining = false;
  }
}
