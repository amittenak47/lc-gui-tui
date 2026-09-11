/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { conflictInkBackingSize, conflictVisibleInkTiles } from "./conflictInkPaintPlan";
import { ConflictInkPainter } from "./conflictInkPaint";
import { paintInkAtScale, type InkOp } from "../canvas/rasterInk";

vi.mock("../canvas/rasterInk", () => ({ paintInkAtScale: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("merge ink raster budget", () => {
  it("allocates only short strips near the viewport on a very long page", () => {
    const tiles = conflictVisibleInkTiles([{ page: 1, left: 0, top: 0, width: 400, height: 100000 }], 50000, 800);
    expect(tiles.length).toBeLessThanOrEqual(7);
    expect(tiles.every(tile => tile.height <= 512 && tile.top >= 48640 && tile.top <= 51600)).toBe(true);
    expect(tiles[0].top).toBeGreaterThanOrEqual(49664);
    expect(new Set(tiles.map(tile => tile.key)).size).toBe(tiles.length);
  });
  it("keeps the native DPR while bounding each backing store", () => {
    expect(conflictInkBackingSize(400, 512, 2.5)).toEqual({ width: 1000, height: 1280, dpr: 2.5 });
    expect(conflictInkBackingSize(3000, 512, 3).width).toBe(4096);
  });
  it("does not repaint a cached strip after a Keep/Drop or return scroll", async () => {
    vi.stubGlobal("Worker", undefined);
    const context = {} as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const ops = [{ kind: "erase", radius: 2, points: [{x: 1, y: 2, pressure: 1}] }] satisfies InkOp[];
    const painter = new ConflictInkPainter([{ page: 1, ops, scale: 0.5, originX: 10, originY: 20 }]);
    const job = { key: "a", page: 1, width: 400, height: 512, offsetY: 512, dpr: 2 };
    const signal = new AbortController().signal;
    const first = await painter.paint(job, signal);
    const calls = vi.mocked(paintInkAtScale).mock.calls.length;
    expect(await painter.paint(job, signal)).toBe(first);
    expect(vi.mocked(paintInkAtScale).mock.calls).toHaveLength(calls);
    expect(paintInkAtScale).toHaveBeenLastCalledWith(context, ops, { x: 10, y: 1044 }, 1);
    painter.dispose();
  });
  it("skips cancelled requests before rasterizing them", async () => {
    const painter = new ConflictInkPainter([]);
    const controller = new AbortController(); controller.abort();
    const before = vi.mocked(paintInkAtScale).mock.calls.length;
    expect(await painter.paint({ key: "cancelled", page: 1, width: 300, height: 512, offsetY: 0, dpr: 2 }, controller.signal)).toBeNull();
    expect(vi.mocked(paintInkAtScale).mock.calls).toHaveLength(before);
    painter.dispose();
  });
});
