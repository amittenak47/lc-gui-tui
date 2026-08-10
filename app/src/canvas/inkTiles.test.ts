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

  /*
   * Undo used to drop every tile, and `draw` stands a coarser *cached* tile in
   * for anything that misses its time budget — so with the cache emptied the
   * squares the budget never reached came back as holes, in a band across the
   * lower half because tiles are walked top-to-bottom.
   */
  describe("setOps keeps the tiles a change did not touch", () => {
    it("drops only the tiles the removed stroke covered", () => {
      const { cache } = makeCache();
      const far = draw([0, 0], [40, 40]);
      const near = draw([700, 500], [740, 540]);
      cache.setOps([far, near]);
      const { ctx } = destinationContext();
      cache.draw(ctx, screen(1), 1);
      const before = cache.size;
      expect(before).toBe(6);

      // Undo the second stroke: the first stroke's corner is untouched.
      cache.setOps([far]);
      expect(cache.size).toBeGreaterThan(0);
      expect(cache.size).toBeLessThan(before);
    });

    it("keeps every tile when the history did not change", () => {
      const { cache } = makeCache();
      const only = draw([0, 0], [40, 40]);
      cache.setOps([only]);
      const { ctx } = destinationContext();
      cache.draw(ctx, screen(1), 1);
      const before = cache.size;
      // A fresh array of the same ops is what a re-render hands us.
      cache.setOps([only]);
      expect(cache.size).toBe(before);
    });

    it("composites an appended stroke instead of rebuilding", () => {
      const { cache, canvases } = makeCache();
      const first = draw([0, 0], [40, 40]);
      cache.setOps([first]);
      const { ctx } = destinationContext();
      cache.draw(ctx, screen(1), 1);
      const built = canvases.created.length;
      cache.setOps([first, draw([100, 100], [140, 140])]);
      expect(cache.size).toBe(6);
      expect(canvases.created.length).toBe(built);
    });

    it("clears everything when the page is replaced wholesale", () => {
      const { cache } = makeCache();
      cache.setOps([draw([0, 0], [40, 40])]);
      const { ctx } = destinationContext();
      cache.draw(ctx, screen(1), 1);
      expect(cache.size).toBe(6);
      cache.setOps([draw([10, 10], [50, 50])]);
      expect(cache.size).toBe(0);
    });

    it("drops the tiles under an undone erase, which paints nothing itself", () => {
      const { cache } = makeCache();
      const stroke = draw([0, 0], [40, 40]);
      const rub = erase(20, [700, 500], [720, 520]);
      cache.setOps([stroke, rub]);
      const { ctx } = destinationContext();
      cache.draw(ctx, screen(1), 1);
      const before = cache.size;
      cache.setOps([stroke]);
      expect(cache.size).toBeLessThan(before);
      expect(cache.size).toBeGreaterThan(0);
    });
  });

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

  it("rasterises nothing new while the camera is moving", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const afterFirst = canvases.created.length;

    // A zoom past √2 lands on the next level, where nothing is cached. Under a
    // gesture that must not turn into a screenful of fresh rasterisation.
    cache.setMoving(true);
    cache.draw(ctx, screen(1.5), 1);
    expect(canvases.created.length).toBe(afterFirst);
  });

  it("still covers the screen from the pinned level while moving", () => {
    const { cache } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);

    cache.setMoving(true);
    const { ctx: moving, blits } = destinationContext();
    cache.draw(moving, screen(1.5), 1);
    // Cheap is not the same as blank: every visible square is still blitted,
    // from the level the gesture opened on.
    expect(blits.length).toBeGreaterThan(0);
  });

  it("re-levels on the settle", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    cache.setMoving(true);
    cache.draw(ctx, screen(1.5), 1);
    const afterGesture = canvases.created.length;

    cache.setMoving(false);
    cache.draw(ctx, screen(1.5), 1);
    // The softness the gesture traded for smoothness is paid back at the lift.
    expect(canvases.created.length).toBeGreaterThan(afterGesture);
  });

  it("gives up the pin when the zoom runs away from it", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    cache.setMoving(true);
    const afterFirst = canvases.created.length;

    // Far enough out that holding level 0 would want a screenful of squares
    // per octave. Re-levelling is the cheaper answer and the pin yields.
    cache.draw(ctx, screen(0.2), 1);
    expect(canvases.created.length).toBeGreaterThan(afterFirst);
  });

  it("takes the normal ladder when a gesture opens on an uncached level", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [700, 500])]);
    const { ctx } = destinationContext();
    // Moving from the very first frame: there is no cached level to pin to, so
    // pinning would buy a blit of nothing.
    cache.setMoving(true);
    cache.draw(ctx, screen(1), 1);
    expect(canvases.created.length).toBeGreaterThan(0);
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

  it("draws a committed stroke into its tiles instead of dropping them", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [10, 10])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const before = cache.size;
    // The tile the stroke lands on — the one that had to stroke something.
    const landed = canvases.created.find((tile) => tile.ops.includes("stroke"));
    expect(landed).toBeDefined();
    const strokesBefore = landed!.ops.filter((op) => op === "stroke").length;

    cache.appendOp(draw([5, 5], [20, 20]));

    // Nothing is thrown away, and the new stroke went straight onto the tile.
    expect(cache.size).toBe(before);
    expect(landed!.ops.filter((op) => op === "stroke").length).toBeGreaterThan(
      strokesBefore,
    );
    // Compositing, not rebuilding: the tile was never cleared and replayed.
    expect(landed!.ops.lastIndexOf("clearRect")).toBeLessThan(
      landed!.ops.lastIndexOf("stroke"),
    );
  });

  it("costs the same to commit onto a full tile as onto an empty one", () => {
    const busy = makeCache();
    const empty = makeCache();
    // Fifty strokes stacked in one square — the state a page of writing reaches.
    const crowd = Array.from({ length: 50 }, (_, i) =>
      draw([i, 0], [i, 40]),
    );
    busy.cache.setOps(crowd);
    empty.cache.setOps([]);
    busy.cache.draw(destinationContext().ctx, screen(1), 1);
    empty.cache.draw(destinationContext().ctx, screen(1), 1);

    const drawnIn = (created: Array<{ ops: string[] }>) =>
      created.reduce((sum, tile) => sum + tile.ops.filter((op) => op === "stroke").length, 0);
    const busyBefore = drawnIn(busy.canvases.created);
    const emptyBefore = drawnIn(empty.canvases.created);

    const stroke = draw([10, 10], [30, 30]);
    busy.cache.appendOp(stroke);
    empty.cache.appendOp(stroke);

    // The whole point: a commit replays the one new stroke, not the fifty it
    // happens to be sitting on top of.
    expect(drawnIn(busy.canvases.created) - busyBefore).toBe(
      drawnIn(empty.canvases.created) - emptyBefore,
    );
  });

  it("keeps an erase committed after a stroke punching through it", () => {
    const { cache, canvases } = makeCache();
    cache.setOps([draw([0, 0], [40, 40])]);
    const { ctx } = destinationContext();
    cache.draw(ctx, screen(1), 1);
    const landed = canvases.created.find((tile) => tile.ops.includes("stroke"))!;
    const fillsBefore = landed.ops.filter((op) => op === "fill").length;
    cache.appendOp(erase(6, [20, 20]));
    // `destination-out` against the tile's own pixels is what a replay would
    // have done too, so the rub-out composites in the same as a stroke does.
    expect(landed.ops.filter((op) => op === "fill").length).toBeGreaterThan(fillsBefore);
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

  it("fills a square it could not afford from another cached level", () => {
    let clock = 0;
    let tick = 0;
    const { cache } = makeCache({ now: () => (clock += tick) });
    cache.setOps([draw([0, 0], [900, 700])]);
    const { ctx, blits } = destinationContext();

    // Rasterise level 0, then level 1, both in full. The old code remembered
    // only the last level that completed, so from here "the level to fall back
    // to" was the level we are already on.
    cache.draw(ctx, screen(1), 1);
    cache.draw(ctx, screen(2), 1);
    expect(cache.settled).toBe(true);

    // Pan at the same zoom onto ground level 1 has never covered, with no
    // budget left to rasterise any of it. Level 0 still holds that ground, so
    // the squares must come back soft rather than empty — an empty one is
    // committed ink missing from the screen.
    tick = 1000;
    blits.length = 0;
    cache.draw(ctx, screen(2, -600, 0), 1);
    expect(cache.settled).toBe(false);
    expect(blits.length).toBeGreaterThan(0);
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
