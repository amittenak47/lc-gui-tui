import { bakeSpine, type BakeResult } from "./bake";
import { capillaryRelax } from "./style";
import type { InkLabBakeOptions } from "./engine";
import type { SpineDot } from "./instance";
import type { InkBakeRequest, InkBakeResponse } from "./bake.worker";

type Pending = {
  resolve: (result: BakeResult) => void;
  reject: (error: unknown) => void;
};

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function failWorker(error: unknown): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

async function getWorker(): Promise<Worker | null> {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    const { default: InkBakeWorker } = await import("./bake.worker.ts?worker");
    const next = new InkBakeWorker();
    next.onmessage = (event: MessageEvent<InkBakeResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      request.resolve({
        points: event.data.points,
        bake: event.data.bake,
        bakeMs: event.data.bakeMs,
      });
    };
    next.onerror = (event) => failWorker(event.error ?? new Error(event.message));
    worker = next;
  } catch {
    worker = null;
  }
  return worker;
}

function mainThreadFallback(points: readonly SpineDot[], options: InkLabBakeOptions): Promise<BakeResult> {
  return new Promise((resolve) => {
    const run = () => {
      const baked = bakeSpine(points, options);
      resolve({
        ...baked,
        points: options.capillary ? capillaryRelax(baked.points) : baked.points,
      });
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 250 });
    } else {
      setTimeout(run, 0);
    }
  });
}

/** Catmull/clothoid work never runs on the pointer-up event stack. */
export async function bakeSpineOffThread(
  points: readonly SpineDot[],
  options: InkLabBakeOptions,
): Promise<BakeResult> {
  const target = await getWorker();
  if (!target) return mainThreadFallback(points, options);
  const id = nextId++;
  return new Promise<BakeResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, points: points.slice(), options } satisfies InkBakeRequest);
  }).catch(() => mainThreadFallback(points, options));
}
