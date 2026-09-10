import type { InkOp, SceneBounds } from "../rasterInk";
import { noteInkTileRaster } from "../inkTileMetrics";
import type { InkTileRasterRequest, InkTileRasterResponse } from "./tileRaster.worker";

type Pending = {
  resolve: (bitmap: ImageBitmap | null) => void;
};

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
let lastOps: readonly InkOp[] | null = null;
let lastClip: SceneBounds | null = null;

function failWorker(error: unknown): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.resolve(null);
  pending.clear();
  void error;
}

async function getWorker(): Promise<Worker | null> {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    const { default: InkTileRasterWorker } = await import("./tileRaster.worker.ts?worker");
    const next = new InkTileRasterWorker();
    next.onmessage = (event: MessageEvent<InkTileRasterResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      noteInkTileRaster(event.data.renderMs, event.data.sdfMs);
      request.resolve(event.data.bitmap);
    };
    next.onerror = (event) => failWorker(event.error ?? new Error(event.message));
    worker = next;
  } catch {
    worker = null;
  }
  return worker;
}

export type InkTileRasterJob = {
  ops: readonly InkOp[];
  clip: SceneBounds | null;
  level: number;
  tx: number;
  ty: number;
  tilePx?: number;
};

/** Raster one scene tile off the UI thread. Null means caller should paint locally. */
export async function rasterInkTileOffThread(
  job: InkTileRasterJob,
): Promise<ImageBitmap | null> {
  const target = await getWorker();
  if (!target) return null;
  if (job.ops !== lastOps || job.clip !== lastClip) {
    lastOps = job.ops;
    lastClip = job.clip;
    const opsMsg: InkTileRasterRequest = {
      type: "ops",
      ops: job.ops as InkOp[],
      clip: job.clip,
      tilePx: job.tilePx,
    };
    target.postMessage(opsMsg);
  }
  const id = nextId++;
  return new Promise<ImageBitmap | null>((resolve) => {
    const finish = (bitmap: ImageBitmap | null) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve(bitmap);
    };
    pending.set(id, { resolve: finish });
    const payload: InkTileRasterRequest = {
      type: "render",
      id,
      level: job.level,
      tx: job.tx,
      ty: job.ty,
    };
    target.postMessage(payload);
    setTimeout(() => finish(null), 4000);
  }).catch(() => null);
}

export function resetInkTileRasterWorkerForTests(): void {
  worker?.terminate();
  worker = undefined;
  pending.clear();
  nextId = 1;
  lastOps = null;
  lastClip = null;
}
