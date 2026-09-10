import { afterEach, describe, expect, it, vi } from "vitest";

import { inkOpsFingerprint } from "./inkOpsFingerprint";
import { noteInkTileRaster, peekInkTileMetrics, resetInkTileMetrics } from "./inkTileMetrics";
import { inkTilePersistKey, loadPersistedInkTiles, persistInkTile, resetInkTileStoreForTests } from "./inkTileStore";
import { NO_PRESSURE, type InkDrawOp } from "./rasterInk";

function draw(...pairs: Array<[number, number]>): InkDrawOp {
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

describe("inkOpsFingerprint", () => {
  it("changes when committed geometry changes", () => {
    const a = inkOpsFingerprint([draw([0, 0], [10, 0])]);
    const b = inkOpsFingerprint([draw([0, 0], [11, 0])]);
    expect(a).not.toBe(b);
  });

  it("is stable for the same ops", () => {
    const ops = [draw([1, 2], [3, 4])];
    expect(inkOpsFingerprint(ops)).toBe(inkOpsFingerprint(ops));
  });
});

describe("inkTileMetrics", () => {
  afterEach(() => {
    resetInkTileMetrics();
  });

  it("records renderTile and paintSdfSpines separately", () => {
    noteInkTileRaster(12.4, 8.1);
    noteInkTileRaster(4, 20);
    const peek = peekInkTileMetrics();
    expect(peek.renderMs).toBe(4);
    expect(peek.sdfMs).toBe(20);
    expect(peek.maxRenderMs).toBe(12.4);
    expect(peek.maxSdfMs).toBe(20);
    expect(peek.tiles).toBe(2);
  });
});

describe("inkTileStore", () => {
  it("does not reuse potentially incomplete bitmaps from the old worker cache", () => {
    const ops = [draw([1, 2], [3, 4])];
    expect(inkTilePersistKey(ops, null)).not.toBe(inkOpsFingerprint(ops));
    expect(inkTilePersistKey(ops, null)).toBe(inkTilePersistKey(ops, null));
  });
  afterEach(() => {
    resetInkTileStoreForTests();
    vi.unstubAllGlobals();
  });

  it("does not throw when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await persistInkTile("sig", {
      level: 0,
      tx: 0,
      ty: 0,
      blob: new Blob(["x"]),
      width: 1,
      height: 1,
    });
    expect(await loadPersistedInkTiles("sig")).toEqual([]);
  });
});
