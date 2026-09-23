import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InkOp } from "../rasterInk";
import type { InkTileRasterRequest, InkTileRasterResponse } from "./tileRaster.worker";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage: ((event: MessageEvent<InkTileRasterResponse>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}> }));
vi.mock("./tileRaster.worker.ts?worker", () => ({ default: class {
  onmessage = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { mocks.instances.push(this); }
} }));
import { rasterInkTileOffThread, resetInkTileRasterWorkerForTests } from "./tileRasterClient";

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("Worker", class {}); mocks.instances.length = 0; });
afterEach(() => { resetInkTileRasterWorkerForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const job = (ops: InkOp[]) => ({ ops, clip: null, level: 0, tx: 0, ty: 0 });
async function send(ops: InkOp[]) {
  const result = rasterInkTileOffThread(job(ops));
  await vi.waitFor(() => expect(mocks.instances[0]?.postMessage).toHaveBeenCalled());
  // Drain the worker import / request continuation without running timeouts.
  await Promise.resolve();
  return { result };
}
function reply(bitmap: ImageBitmap | null = null) {
  const worker = mocks.instances[0]!;
  const msg = worker.postMessage.mock.calls.at(-1)![0] as InkTileRasterRequest;
  if (msg.type !== "render") throw new Error("Expected render");
  worker.onmessage!({ data: { id: msg.id, bitmap, renderMs: 0, sdfMs: 0 } } as MessageEvent<InkTileRasterResponse>);
}

it("shares concurrent startup and clears successful request timers", async () => {
  const ops: InkOp[] = [];
  const a = rasterInkTileOffThread(job(ops));
  const b = rasterInkTileOffThread(job(ops));
  await vi.waitFor(() => expect(mocks.instances[0]?.postMessage.mock.calls.length).toBe(3));
  expect(mocks.instances).toHaveLength(1);
  const worker = mocks.instances[0]!;
  for (const [msg] of worker.postMessage.mock.calls) {
    if (msg.type === "render") worker.onmessage!({ data: { id: msg.id, bitmap: null, renderMs: 0, sdfMs: 0 } } as MessageEvent<InkTileRasterResponse>);
  }
  await Promise.all([a, b]);
  expect(vi.getTimerCount()).toBe(0);
});

it("reuses two alternating pane histories and resends an evicted history", async () => {
  const a: InkOp[] = [], b: InkOp[] = [], c: InkOp[] = [];
  for (const ops of [a, b, a, b, c, a]) {
    const { result } = await send(ops); reply(); await result;
  }
  const histories = mocks.instances[0]!.postMessage.mock.calls.filter(([msg]) => msg.type === "ops");
  expect(histories).toHaveLength(4);
  expect(histories.map(([msg]) => msg.ops)).toEqual([a, b, c, a]);
});

it("closes late bitmaps after timeout instead of retaining GPU resources", async () => {
  const { result } = await send([]);
  await vi.advanceTimersByTimeAsync(4000);
  expect(await result).toBeNull();
  const close = vi.fn();
  reply({ close } as unknown as ImageBitmap);
  expect(close).toHaveBeenCalledOnce();
});
