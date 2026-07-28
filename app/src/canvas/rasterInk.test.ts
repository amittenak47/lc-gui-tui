import { describe, expect, it } from "vitest";

import {
  clampExportScale,
  eraserSceneRadius,
  eraserScreenRadius,
  exportScaleFrom,
  inkLineWidth,
  inkOpsBounds,
  inkStrokesFromOps,
  paintInkAtScale,
  scenePointFromCanvasPixel,
  scenePointFromPointer,
  unionSceneBounds,
  type InkOp,
  type ScenePoint,
} from "./rasterInk";

function points(...pairs: Array<[number, number]>): ScenePoint[] {
  return pairs.map(([x, y]) => ({ x, y, pressure: 0.5 }));
}

function draw(...pairs: Array<[number, number]>): InkOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    pressureSensitive: false,
    points: points(...pairs),
  };
}

function erase(radius: number, ...pairs: Array<[number, number]>): InkOp {
  return { kind: "erase", radius, points: points(...pairs) };
}

describe("rasterInk sizing", () => {
  it("maps slider value to scene units", () => {
    expect(eraserSceneRadius(2)).toBe(3.5);
    expect(eraserScreenRadius(2, 1)).toBe(3.5);
    expect(eraserScreenRadius(2, 0.5)).toBe(1.75);
  });

  it("honours stylus pressure for line width", () => {
    expect(inkLineWidth(2, 0.5)).toBeLessThan(inkLineWidth(2, 0.9));
    expect(inkLineWidth(2, 0.2)).toBeGreaterThan(0);
    expect(inkLineWidth(2, 0.9, false)).toBe(inkLineWidth(2, 0.2, false));
  });
});

describe("rasterInk coordinates", () => {
  const viewport = { zoom: 2, scrollX: 10, scrollY: 5 };

  it("round-trips pointer → scene → canvas pixel", () => {
    const rect = { left: 120, top: 80, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    const clientX = 220;
    const clientY = 180;
    const scene = scenePointFromPointer(clientX, clientY, rect, viewport, 0.5);
    const localX = (scene.x + viewport.scrollX) * viewport.zoom;
    const localY = (scene.y + viewport.scrollY) * viewport.zoom;
    expect(localX).toBeCloseTo(clientX - rect.left);
    expect(localY).toBeCloseTo(clientY - rect.top);
  });

  it("matches excalidraw viewport formula when canvas aligns with the container", () => {
    const offsetLeft = 120;
    const offsetTop = 80;
    const rect = { left: offsetLeft, top: offsetTop, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    const clientX = 300;
    const clientY = 250;
    const scene = scenePointFromPointer(clientX, clientY, rect, viewport, 0.5);
    expect(scene.x).toBeCloseTo((clientX - offsetLeft) / viewport.zoom - viewport.scrollX);
    expect(scene.y).toBeCloseTo((clientY - offsetTop) / viewport.zoom - viewport.scrollY);
    const back = scenePointFromCanvasPixel(
      (scene.x + viewport.scrollX) * viewport.zoom,
      (scene.y + viewport.scrollY) * viewport.zoom,
      viewport,
    );
    expect(back.x).toBeCloseTo(scene.x);
    expect(back.y).toBeCloseTo(scene.y);
  });
});

describe("inkStrokesFromOps", () => {
  it("turns draw ops into recognizer strokes in writing order", () => {
    const strokes = inkStrokesFromOps([draw([0, 0], [10, 0]), draw([0, 20], [10, 20])]);
    expect(strokes).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 0, y: 20 }, { x: 10, y: 20 }] },
    ]);
  });

  it("ignores erase-only history", () => {
    expect(inkStrokesFromOps([erase(4, [0, 0])])).toEqual([]);
  });

  it("thins out the stamps drawing lays down for smoothness", () => {
    // Drawing stamps every fraction of a line width; the recognizer only needs
    // the path, so sub-unit spacing is payload for nothing.
    const dense = draw([0, 0], [0.2, 0], [0.4, 0], [0.6, 0], [20, 0]);
    expect(inkStrokesFromOps([dense])).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    ]);
  });

  it("drops points the eraser covered, whenever the erase happened", () => {
    // paintRasterInk applies every erase after every draw, so a rub-out that
    // predates a stroke still clears it. Recognition has to agree.
    const before = inkStrokesFromOps([erase(5, [50, 0]), draw([0, 0], [50, 0])]);
    const after = inkStrokesFromOps([draw([0, 0], [50, 0]), erase(5, [50, 0])]);
    expect(before).toEqual(after);
    expect(before).toEqual([]);
  });

  it("splits a stroke the eraser cut in half", () => {
    const stroke = draw([0, 0], [20, 0], [40, 0], [60, 0], [80, 0]);
    expect(inkStrokesFromOps([stroke, erase(5, [40, 0])])).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { points: [{ x: 60, y: 0 }, { x: 80, y: 0 }] },
    ]);
  });

  it("drops runs too short to be a stroke", () => {
    // A single surviving point is an eraser crumb; feeding it to ML Kit as a
    // stroke only adds noise to recognized_text.
    expect(inkStrokesFromOps([draw([0, 0], [20, 0]), erase(5, [20, 0])])).toEqual([]);
  });
});

describe("ink bounds", () => {
  it("pads the drawn points by the widest line they could carry", () => {
    const bounds = inkOpsBounds([draw([0, 0], [10, 20])]);
    const half = inkLineWidth(2, 1, false) / 2;
    expect(bounds).toEqual({ minX: -half, minY: -half, maxX: 10 + half, maxY: 20 + half });
  });

  it("reports nothing to composite when only erases were recorded", () => {
    expect(inkOpsBounds([erase(4, [0, 0])])).toBeNull();
  });

  it("unions boxes and passes through a missing side", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b = { minX: -5, minY: 4, maxX: 4, maxY: 30 };
    expect(unionSceneBounds(a, b)).toEqual({ minX: -5, minY: 0, maxX: 10, maxY: 30 });
    expect(unionSceneBounds(null, b)).toEqual(b);
    expect(unionSceneBounds(a, null)).toEqual(a);
    expect(unionSceneBounds(null, null)).toBeNull();
  });
});

describe("exportScaleFrom", () => {
  const bounds = { minX: -10, minY: -10, maxX: 190, maxY: 90 };

  it("reads the scale back off the canvas excalidraw returned", () => {
    expect(exportScaleFrom(400, 200, bounds)).toBe(2);
  });

  it("tolerates whole-pixel rounding on the two axes", () => {
    expect(exportScaleFrom(201, 100, bounds)).toBeCloseTo(1, 1);
  });

  it("refuses a canvas that no longer matches the bounds", () => {
    // Better an ink-less PNG than one with the handwriting in the wrong place.
    expect(exportScaleFrom(400, 100, bounds)).toBeNull();
    expect(exportScaleFrom(0, 0, bounds)).toBeNull();
    expect(exportScaleFrom(400, 200, { minX: 5, minY: 5, maxX: 5, maxY: 5 })).toBeNull();
  });
});

/** Enough of a 2D context to check what lands where, without a real canvas. */
function recordingContext() {
  let transform = [1, 0, 0, 1, 0, 0];
  let composite = "source-over";
  const strokes: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  const erased: Array<{ x: number; y: number; r: number; composite: string }> = [];
  let pen = { x: 0, y: 0 };

  const map = (x: number, y: number) => ({
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  });

  const ctx = {
    get globalCompositeOperation() {
      return composite;
    },
    set globalCompositeOperation(value: string) {
      composite = value;
    },
    strokeStyle: "",
    fillStyle: "",
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      transform = [a, b, c, d, e, f];
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      pen = map(x, y);
    },
    lineTo(x: number, y: number) {
      strokes.push({ from: pen, to: map(x, y) });
      pen = map(x, y);
    },
    stroke() {},
    arc(x: number, y: number, r: number) {
      erased.push({ ...map(x, y), r: r * transform[0], composite });
    },
    fill() {},
  };

  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, erased };
}

describe("paintInkAtScale", () => {
  it("maps scene points to export pixels relative to the canvas origin", () => {
    const { ctx, strokes } = recordingContext();
    paintInkAtScale(ctx, [draw([110, 60], [130, 60])], { x: 100, y: 50 }, 2);
    expect(strokes).toEqual([
      { from: { x: 20, y: 20 }, to: { x: 60, y: 20 } },
    ]);
  });

  it("erases after every draw and in the same composite mode as the live layer", () => {
    const { ctx, erased } = recordingContext();
    paintInkAtScale(ctx, [erase(4, [110, 60]), draw([110, 60], [130, 60])], { x: 100, y: 50 }, 2);
    expect(erased).toEqual([{ x: 20, y: 20, r: 8, composite: "destination-out" }]);
  });

  it("leaves the context ready for the caller to blit onto", () => {
    const { ctx } = recordingContext();
    paintInkAtScale(ctx, [erase(4, [0, 0])], { x: 0, y: 0 }, 1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });
});

describe("clampExportScale", () => {
  it("leaves an export that already fits alone", () => {
    expect(clampExportScale(2, { minX: 0, minY: 0, maxX: 100, maxY: 400 }, 1000)).toBe(2);
  });

  it("shrinks to the cap when a far-flung stroke stretched the board", () => {
    // A dot left behind after panning across the scene would otherwise ask for a
    // canvas the browser refuses to allocate.
    const bounds = { minX: 0, minY: 0, maxX: 20000, maxY: 500 };
    const scale = clampExportScale(1, bounds, 1000);
    expect(scale).toBeCloseTo(0.05);
    expect((bounds.maxX - bounds.minX) * scale).toBeCloseTo(1000);
  });
});
