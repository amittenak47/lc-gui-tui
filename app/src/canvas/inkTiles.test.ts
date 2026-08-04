import { describe, expect, it } from "vitest";

import {
  boundsOverlap,
  inkOpBounds,
  InkTileCache,
  intersectBounds,
  levelScale,
  pickRenderLevel,
  tileRangeFor,
  tileSceneSize,
  viewportSceneBounds,
  LEVEL_STEP,
  TILE_PX,
} from "./inkTiles";
import { NO_PRESSURE, type InkOp, type ViewportTransform } from "./rasterInk";

function draw(...pairs: Array<[number, number]>): InkOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE })),
  };
}

function erase(radius: number, ...pairs: Array<[number, number]>): InkOp {
  return {
    kind: "erase",
    radius,
    points: pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE })),
  };
}

describe("level ladder", () => {
  it("snaps a screen scale onto the ladder", () => {
    expect(pickRenderLevel(1)).toBe(0);
    expect(pickRenderLevel(2)).toBe(1);
    expect(pickRenderLevel(0.5)).toBe(-1);
    expect(pickRenderLevel(Math.SQRT2)).toBeCloseTo(LEVEL_STEP);
  });

  it("never resamples a tile by more than a half step", () => {
    for (const scale of [0.31, 0.7, 1, 1.3, 2.9, 6.4, 11]) {
      const factor = scale / levelScale(pickRenderLevel(scale));
      expect(factor).toBeGreaterThan(2 ** (-LEVEL_STEP / 2) - 1e-9);
      expect(factor).toBeLessThan(2 ** (LEVEL_STEP / 2) + 1e-9);
    }
  });

  it("halves the scene a tile covers each time the level goes up", () => {
    expect(tileSceneSize(0)).toBe(TILE_PX);
    expect(tileSceneSize(1)).toBe(TILE_PX / 2);
    expect(tileSceneSize(-1)).toBe(TILE_PX * 2);
  });
});

describe("tile ranges", () => {
  it("covers the viewport and nothing past it", () => {
    const range = tileRangeFor({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 100);
    expect(range).toEqual({ minTx: 0, minTy: 0, maxTx: 0, maxTy: 0 });
  });

  it("spans the tiles a straddling view touches", () => {
    const range = tileRangeFor({ minX: -10, minY: 5, maxX: 210, maxY: 95 }, 100);
    expect(range).toEqual({ minTx: -1, minTy: 0, maxTx: 2, maxTy: 0 });
  });

  it("reads the visible scene box off the camera", () => {
    const viewport: ViewportTransform = {
      zoom: 2,
      scrollX: -50,
      scrollY: -20,
      offsetLeft: 0,
      offsetTop: 0,
      width: 400,
      height: 200,
    };
    expect(viewportSceneBounds(viewport)).toEqual({
      minX: 50,
      minY: 20,
      maxX: 250,
      maxY: 120,
    });
  });
});

describe("op bounds", () => {
  it("pads a stroke by half its widest line", () => {
    const bounds = inkOpBounds(draw([10, 10], [30, 20]));
    expect(bounds.minX).toBeLessThan(10);
    expect(bounds.maxX).toBeGreaterThan(30);
    expect(bounds.maxY).toBeGreaterThan(20);
  });

  it("pads an erase by its radius", () => {
    expect(inkOpBounds(erase(8, [0, 0]))).toEqual({
      minX: -8,
      minY: -8,
      maxX: 8,
      maxY: 8,
    });
  });

  it("survives an op with no points", () => {
    expect(inkOpBounds(draw())).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("bounds helpers", () => {
  it("detects overlap without counting a shared edge", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(boundsOverlap(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(true);
    expect(boundsOverlap(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
  });

  it("returns null when boxes only touch", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(intersectBounds(a, { minX: 4, minY: 4, maxX: 6, maxY: 20 })).toEqual({
      minX: 4,
      minY: 4,
      maxX: 6,
      maxY: 10,
    });
    expect(intersectBounds(a, { minX: 10, minY: 0, maxX: 12, maxY: 4 })).toBeNull();
  });
});

/** A canvas stand-in that records what the cache asks of it. */
function fakeCanvasFactory() {
  const created: Array<{ width: number; height: number; ops: string[] }> = [];
  const factory = (width: number, height: number) => {
    const record = { width, height, ops: [] as string[] };
    created.push(record);
    const ctx = {
      setTransform: () => record.ops.push("setTransform"),
      clearRect: () => record.ops.push("clearRect"),
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      rect: () => {},
      clip: () => {},
      stroke: () => record.ops.push("stroke"),
      fill: () => record.ops.push("fill"),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
    };
    return {
      width,
      height,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
  };
  return { factory, created };
}

/** A destination context that records the blits. */
function destinationContext() {
  const blits: Array<{ args: number }> = [];
  const ctx = {
    drawImage: (...args: unknown[]) => blits.push({ args: args.length }),
    setTransform: () => {},
    clearRect: () => {},
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, blits };
}

function screen(zoom: number, scrollX = 0, scrollY = 0): ViewportTransform {
  return { zoom, scrollX, scrollY, offsetLeft: 0, offsetTop: 0, width: 800, height: 600 };
}

describe("InkTileCache", () => {
  function makeCache(overrides = {}) {
    const canvases = fakeCanvasFactory();
    const scheduled: Array<() => void> = [];
    const cache = new InkTileCache({
      createCanvas: canvases.factory,
      // Never run out of budget inside a test, so behaviour is deterministic.
      now: () => 0,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: () => {},
      ...overrides,
    });
    return { cache, canvases, scheduled };
  }

  it("blits one image per visible tile", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [50, 50])]);
    const { ctx, blits } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    // 800x600 scene units at level 0 (384-unit tiles) is 3 x 2 tiles.
    expect(blits).toHaveLength(6);
    expect(cache.size).toBe(6);
  });

  it("reuses tiles when the camera only pans", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [50, 50])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const afterFirst = canvases.created.length;
    // Nudge by a few scene units — the same tiles are still on screen.
    cache.draw(ctx, screen(1, -8, -8), 1);
    expect(canvases.created.length).toBe(afterFirst);
  });

  it("rasterises only the newly exposed tiles on a longer pan", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [2000, 50])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const afterFirst = canvases.created.length;
    // One tile's worth to the right: a fresh column, not a fresh screen.
    cache.draw(ctx, screen(1, -tileSceneSize(0), 0), 1);
    const exposed = canvases.created.length - afterFirst;
    expect(exposed).toBeGreaterThan(0);
    expect(exposed).toBeLessThan(afterFirst);
  });

  it("keeps drawing while a zoom crosses a level, without a blank frame", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx, blits } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    blits.length = 0;
    // Past the half-step, so this is a different level with no tiles yet.
    cache.draw(ctx, screen(2), 1);
    expect(blits.length).toBeGreaterThan(0);
  });

  it("drops only the tiles a committed stroke lands on", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [10, 10])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const before = cache.size;
    cache.appendOp(draw([5, 5], [20, 20]));
    expect(cache.size).toBe(before - 1);
  });

  it("throws everything away when the page clip changes", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [10, 10])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    expect(cache.size).toBeGreaterThan(0);
    cache.setClip({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(cache.size).toBe(0);
  });

  it("ignores a clip set to the value it already had", () => {
    const { cache } = makeCache();
    const clip = { minX: 0, minY: 0, maxX: 400, maxY: 400 };
    cache.setClip(clip);
    cache.setOps([draw([0, 0], [10, 10])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const before = cache.size;
    cache.setClip({ ...clip });
    expect(cache.size).toBe(before);
  });

  it("draws nothing when the page clip is off screen", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [10, 10])]);
    cache.setClip({ minX: 9000, minY: 9000, maxX: 9100, maxY: 9100 });
    const { ctx, blits } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    expect(blits).toHaveLength(0);
  });

  it("defers tiles it cannot afford and finishes them in the background", () => {
    let clock = 0;
    let tick = 1000;
    const { cache, canvases, scheduled } = makeCache({
      // Starts out advancing past both budgets, so nothing fits in `draw`.
      now: () => (clock += tick),
    });
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    expect(cache.settled).toBe(false);
    expect(scheduled.length).toBeGreaterThan(0);
    const madeInDraw = canvases.created.length;
    expect(madeInDraw).toBeLessThan(6);

    // Stop the clock so the background pass has budget, and let it drain.
    tick = 0;
    let guard = 0;
    while (!cache.settled && guard++ < 20) {
      const next = scheduled.shift();
      if (!next) break;
      next();
    }
    expect(cache.settled).toBe(true);
    expect(canvases.created.length).toBeGreaterThan(madeInDraw);
  });

  it("evicts the least recently seen tiles past its budget", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [40000, 40000])]);
    const { ctx } = destinationContext();
    // Walk a long way across the scene; the cache must not grow without bound.
    for (let step = 0; step < 40; step++) {
      cache.draw(ctx, screen(1, -step * 800, 0), 1);
    }
    expect(cache.size).toBeLessThanOrEqual(24);
  });

  it("skips ops that miss the tile", () => {
    const { cache, canvases } = makeCache();
    // One stroke in the top-left tile, one far off to the right.
    cache.setOps([draw([10, 10], [20, 20]), draw([3000, 10], [3010, 20])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const painted = canvases.created.filter((c) => c.ops.includes("stroke"));
    // Only the tile the near stroke lands on does any stroking.
    expect(painted).toHaveLength(1);
  });
});
