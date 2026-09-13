import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { paintHostBoundOps, type InkDrawOp, type InkOp, type ScrollHostLookup } from "../rasterInk";
import { HostInkRasterCache, InkGeometrySnapshot } from "./hostRaster";

const canvas = (w = 400, h = 240) => createCanvas(w, h) as unknown as HTMLCanvasElement;
const stroke = (hostKey = 1): InkDrawOp => ({ kind: "draw", color: "#ff0000", baseWidth: 4,
  maxFullness: 1, pressureClip: 1, pressureSensitive: false, hostKey,
  scrollLeftAtDraw: 100, scrollTopAtDraw: 20,
  points: [{ x: 70, y: 80, pressure: 0.5 }, { x: 150, y: 80, pressure: 0.5 }] });
const hosts = (scrollLeft = 100, scrollTop = 20): ScrollHostLookup => new Map([[1, {
  bounds: { minX: 20, minY: 20, maxX: 350, maxY: 200 }, scrollLeft, scrollTop,
}]]);
const pixels = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;

describe("host raster cache", () => {
  it.each([1, 1.5, 2])("matches anchored direct painting while scrolling both axes at scale %s", scale => {
    const cache = new HostInkRasterCache(() => canvas());
    const ops = [stroke()];
    cache.sync(ops);
    for (const left of [100, 140, 100]) {
      const direct = canvas(), cached = canvas();
      const a = direct.getContext("2d")!, b = cached.getContext("2d")!;
      a.scale(scale, scale); b.scale(scale, scale);
      paintHostBoundOps(a, ops, hosts(left, 30), scale);
      cache.paint(b, hosts(left, 30), scale);
      expect(pixels(cached)).toEqual(pixels(direct));
    }
  });

  it("reuses raster tiles across repeated horizontal scroll samples and page camera translations", () => {
    const allocate = vi.fn(() => canvas());
    const cache = new HostInkRasterCache(allocate);
    const ops = [stroke()];
    cache.sync(ops);
    const target = canvas(), ctx = target.getContext("2d")!;
    cache.paint(ctx, hosts(), 1);
    const count = allocate.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      cache.sync(ops);
      ctx.setTransform(1, 0, 0, 1, 0, -i);
      cache.paint(ctx, hosts(100 + i), 1);
    }
    expect(allocate).toHaveBeenCalledTimes(count);
  });

  it("invalidates when a new letter, undo, or asynchronous bake changes geometry", () => {
    const allocate = vi.fn(() => canvas());
    const cache = new HostInkRasterCache(allocate);
    const ctx = canvas().getContext("2d")!;
    const op = stroke();
    cache.sync([op]); cache.paint(ctx, hosts(), 1);
    const count = allocate.mock.calls.length;
    op.points = [{ x: 100, y: 140, pressure: 0.5 }, { x: 180, y: 140, pressure: 0.5 }];
    cache.sync([op]); cache.paint(ctx, hosts(), 1);
    expect(allocate.mock.calls.length).toBeGreaterThan(count);
    cache.sync([]);
    ctx.clearRect(0, 0, 400, 240);
    cache.paint(ctx, hosts(), 1);
    expect(pixels(ctx.canvas).some(v => v !== 0)).toBe(false);
  });

  it("preserves destination-out erasing of page ink under a host", () => {
    const ops: InkOp[] = [stroke(), { kind: "erase", radius: 15, hostKey: 1, scrollLeftAtDraw: 100,
      points: [{ x: 90, y: 80, pressure: 0.5 }, { x: 130, y: 80, pressure: 0.5 }] }];
    const cache = new HostInkRasterCache(() => canvas());
    cache.sync(ops);
    const direct = canvas(), cached = canvas();
    for (const c of [direct, cached]) c.getContext("2d")!.fillRect(0, 0, 400, 240);
    paintHostBoundOps(direct.getContext("2d")!, ops, hosts(), 1);
    cache.paint(cached.getContext("2d")!, hosts(), 1);
    expect(pixels(cached)).toEqual(pixels(direct));
  });

  it("bounds raster work for a very tall fence to the visible canvas", () => {
    const allocate = vi.fn(() => canvas());
    const cache = new HostInkRasterCache(allocate);
    cache.sync([stroke()]);
    cache.paint(canvas().getContext("2d")!, new Map([[1, {
      bounds: { minX: 20, minY: 20, maxX: 350, maxY: 100000 }, scrollLeft: 0,
    }]]), 1);
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it("preserves multiply highlighters over page ink", () => {
    const ops = [{ ...stroke(), highlight: true, color: "#ffff00", baseWidth: 20 }];
    const cache = new HostInkRasterCache(() => canvas());
    cache.sync(ops);
    const direct = canvas(), cached = canvas();
    for (const c of [direct, cached]) {
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 400, 240);
    }
    paintHostBoundOps(direct.getContext("2d")!, ops, hosts(), 1);
    cache.paint(cached.getContext("2d")!, hosts(), 1);
    expect(pixels(cached)).toEqual(pixels(direct));
  });

  it("preserves chronological paint order for overlapping nested hosts", () => {
    const ops = [stroke(1), { ...stroke(2), color: "#0000ff" }, { ...stroke(1), color: "#00ff00" }];
    const nested = new Map(hosts());
    nested.set(2, { ...nested.get(1)!, bounds: { minX: 50, minY: 50, maxX: 220, maxY: 180 } });
    const direct = canvas(), cached = canvas();
    const cache = new HostInkRasterCache(() => canvas());
    cache.sync(ops);
    paintHostBoundOps(direct.getContext("2d")!, ops, nested, 1);
    cache.paint(cached.getContext("2d")!, nested, 1);
    expect(pixels(cached)).toEqual(pixels(direct));
  });
});

describe("page/replay geometry freshness", () => {
  it("rejects pre-letter, pre-undo and pre-worker-bake snapshots", () => {
    const snapshot = new InkGeometrySnapshot();
    const op = stroke();
    snapshot.capture([op]);
    expect(snapshot.matches([op])).toBe(true);
    expect(snapshot.matches([op, stroke()])).toBe(false);
    expect(snapshot.matches([])).toBe(false);
    op.points = [...op.points];
    expect(snapshot.matches([op])).toBe(false);
  });
});
