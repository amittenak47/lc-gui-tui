import { describe, expect, it } from "vitest";

import {
  clampExportScale,
  eraserSceneRadius,
  eraserScreenRadius,
  exportScaleFrom,
  hasStylusPressure,
  inkLineWidth,
  inkOpsBounds,
  inkPressureAlpha,
  inkReservoirAlpha,
  inkStrokeAlpha,
  inkStrokeRuns,
  inkStrokeStyle,
  inkSlowness,
  inkSpeedAlphaGain,
  inkSpeedWidthGain,
  inkStrokesFromOps,
  INK_DRY_FLOOR,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_ALPHA_BASE,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_SPEED_WIDTH_RANGE,
  INK_PRESSURE_FLOOR,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  INK_TIP_MIN,
  INK_TIP_STEP,
  inkDryDepth,
  inkFallLength,
  inkLeadLength,
  NO_PRESSURE,
  normalizePressure,
  paintInkAtScale,
  pointerPressure,
  scenePointFromCanvasPixel,
  scenePointFromPointer,
  smoothPressure,
  stampAlongSegment,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  unionSceneBounds,
  type InkOp,
  type ScenePoint,
} from "./rasterInk";

function points(...pairs: Array<[number, number]>): ScenePoint[] {
  return pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE }));
}

function stylusPoints(pressure: number, ...pairs: Array<[number, number]>): ScenePoint[] {
  return pairs.map(([x, y]) => ({ x, y, pressure }));
}

function draw(...pairs: Array<[number, number]>): InkOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
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

  it("keeps tip width stable; ±one tip step under stylus pressure", () => {
    const base = inkLineWidth(2, 0, false);
    expect(inkLineWidth(2, 0.5, true)).toBeCloseTo(base);
    const low = inkLineWidth(2, 0, true);
    const high = inkLineWidth(2, 1, true);
    expect(low).toBeCloseTo(Math.max(INK_TIP_MIN, base - INK_TIP_STEP));
    expect(high).toBeCloseTo(base + INK_TIP_STEP);
    expect(low).toBeLessThan(high);
  });

  it("gives the finest tip a hairline, and never a negative one", () => {
    expect(inkLineWidth(STROKE_WIDTH_MIN, 0, false)).toBeCloseTo(INK_TIP_MIN);
    expect(inkLineWidth(0, 0, false)).toBeCloseTo(INK_TIP_MIN);
    expect(inkLineWidth(-5, 0, false)).toBeCloseTo(INK_TIP_MIN);
  });

  it("still spreads the dial evenly above the finest tip", () => {
    const one = inkLineWidth(1, 0, false);
    const two = inkLineWidth(2, 0, false);
    const three = inkLineWidth(3, 0, false);
    expect(two - one).toBeCloseTo(three - two);
    expect(inkLineWidth(STROKE_WIDTH_MAX, 0, false)).toBeGreaterThan(40);
  });

  it("stamps denser under pressure than at constant width", () => {
    expect(INK_STEP_FACTOR_PRESSURE).toBeLessThan(INK_STEP_FACTOR);
    expect(INK_STEP_FACTOR_PRESSURE).toBeGreaterThan(0);
  });
});

describe("ink reservoir", () => {
  it("starts every stroke at a full nib, whatever the dial says", () => {
    expect(inkReservoirAlpha(0, 1)).toBe(1);
    expect(inkReservoirAlpha(0, 0.2)).toBe(1);
    expect(inkReservoirAlpha(0, 0)).toBe(1);
  });

  it("holds a full dial at exactly 1 forever", () => {
    expect(inkReservoirAlpha(1e9, 1)).toBe(1);
    expect(inkDryDepth(1)).toBe(0);
  });

  it("fades along the stroke, never below the readable floor", () => {
    const dial = 0.4;
    const lead = inkLeadLength(dial);
    const fall = inkFallLength(dial);
    const early = inkReservoirAlpha(lead, dial);
    const late = inkReservoirAlpha(lead + fall + 50, dial);
    expect(early).toBe(1);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThanOrEqual(INK_DRY_FLOOR);
    expect(inkReservoirAlpha(1e9, dial)).toBeCloseTo(1 - inkDryDepth(dial));
  });

  it("keeps alpha at 1 on the flat lead", () => {
    const dial = 0.4;
    const lead = inkLeadLength(dial);
    expect(inkReservoirAlpha(lead - 1, dial)).toBe(1);
    expect(inkReservoirAlpha(5, dial)).toBe(1);
  });

  it("is monotone non-increasing as consumed grows", () => {
    const dial = 0.3;
    let prev = inkReservoirAlpha(0, dial);
    for (let c = 10; c <= 2000; c += 10) {
      const next = inkReservoirAlpha(c, dial);
      expect(next).toBeLessThanOrEqual(prev);
      prev = next;
    }
  });

  it("makes a fuller dial last longer at the same distance", () => {
    const consumed = 1000;
    expect(inkReservoirAlpha(consumed, 0.9)).toBeGreaterThan(inkReservoirAlpha(consumed, 0.3));
    expect(inkReservoirAlpha(consumed, 0.3)).toBeGreaterThan(inkReservoirAlpha(consumed, 0));
  });

  // Distances in nib widths of pen travel: a letter is roughly 50-130 and a
  // line of handwriting a couple of thousand.
  const LETTER = 60;
  const WORD = 400;
  const LINE = 2400;

  it("does not dry out inside the first letter, even on an empty dial", () => {
    // lead=90 at dial 0; LETTER=60 is still on the flat lead.
    expect(inkReservoirAlpha(LETTER, 0)).toBe(1);
  });

  it("spends the empty end of the dial over a word, and the middle over a line", () => {
    // dial 0: lead=90, fall=260; WORD=400 past lead+fall (350) → near floor.
    expect(inkReservoirAlpha(WORD, 0)).toBeLessThan(INK_DRY_FLOOR + 0.1);
    // dial 0.5: lead=540, fall=1010; WORD=400 still on lead → full.
    expect(inkReservoirAlpha(WORD, 0.5)).toBe(1);
  });

  it("settles dial 0.5 across a line and barely moves dial 0.75", () => {
    // LINE=2400 past lead at dial 0.5 → settles near 0.67.
    expect(inkReservoirAlpha(LINE, 0.5)).toBeCloseTo(0.67, 1);
    // dial 0.75: lead=765; WORD=400 still on lead.
    expect(inkReservoirAlpha(WORD, 0.75)).toBe(1);
    // dial 0.75 barely moves across a line.
    const early075 = inkReservoirAlpha(inkLeadLength(0.75), 0.75);
    const late075 = inkReservoirAlpha(LINE, 0.75);
    expect(early075).toBe(1);
    expect(late075).toBeGreaterThan(0.8);
  });

  it("keeps a light touch light but present", () => {
    expect(inkPressureAlpha(0)).toBeCloseTo(INK_PRESSURE_FLOOR);
    expect(inkPressureAlpha(1)).toBeCloseTo(1);
    expect(inkPressureAlpha(0.5)).toBeGreaterThan(INK_PRESSURE_FLOOR);
  });

  it("combines charge and pressure into the sample alpha", () => {
    expect(inkStrokeAlpha(1, 0, false, 0)).toBeCloseTo(1);
    expect(inkStrokeAlpha(1, 1, true, 0)).toBeCloseTo(1);
    expect(inkStrokeAlpha(1, 0, true, 0)).toBeCloseTo(INK_PRESSURE_FLOOR);
    expect(inkStrokeAlpha(0.3, 1, true, 500)).toBeLessThan(
      inkStrokeAlpha(0.3, 1, true, 0),
    );
  });
});

describe("speed ink", () => {
  it("reads an ordinary pace as neutral, and the extremes as the extremes", () => {
    expect(inkSlowness(INK_SPEED_NEUTRAL_PX_MS)).toBeCloseTo(INK_SLOWNESS_NEUTRAL);
    expect(inkSlowness(0)).toBe(1);
    expect(inkSlowness(50)).toBeLessThan(0.1);
    // A pen that is barely moving is at the top of the range, not past it.
    expect(inkSlowness(1e-6)).toBeLessThanOrEqual(1);
  });

  it("does nothing at all when the dial is off", () => {
    for (const slowness of [0, 0.25, 0.5, 0.75, 1]) {
      expect(inkSpeedWidthGain(slowness, 0)).toBe(1);
      expect(inkSpeedAlphaGain(slowness, 0)).toBe(1);
    }
    expect(inkLineWidth(2, 0, false, 1, 0)).toBeCloseTo(inkLineWidth(2, 0, false));
  });

  it("swells a dawdling nib and starves a flicking one", () => {
    const dawdle = inkLineWidth(2, 0, false, 1, 1);
    const normal = inkLineWidth(2, 0, false, INK_SLOWNESS_NEUTRAL, 1);
    const flick = inkLineWidth(2, 0, false, 0, 1);
    expect(dawdle).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(flick);
    // A neutral pace is exactly the pen you would have had with this off.
    expect(normal).toBeCloseTo(inkLineWidth(2, 0, false));
    expect(dawdle).toBeCloseTo(inkLineWidth(2, 0, false) * (1 + INK_SPEED_WIDTH_RANGE));
  });

  it("scales the whole effect with the dial", () => {
    const base = inkLineWidth(2, 0, false);
    const half = inkLineWidth(2, 0, false, 1, 0.5);
    const full = inkLineWidth(2, 0, false, 1, 1);
    expect(half).toBeGreaterThan(base);
    expect(half).toBeLessThan(full);
  });

  it("never asks for more than opaque ink on a full dial", () => {
    const maxSlow = inkStrokeAlpha(1, 0, false, 0, 1, 1);
    expect(maxSlow).toBeLessThanOrEqual(1);
    expect(maxSlow).toBeGreaterThan(0.98);
    expect(maxSlow).toBeCloseTo(0.992);
  });

  it("reads neutral pace as the speed-alpha base when speed ink is on", () => {
    expect(inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 1)).toBeCloseTo(
      INK_SPEED_ALPHA_BASE,
    );
  });

  it("darkens slow strokes more than fast ones at the same alpha gain", () => {
    const slowGain = inkSpeedAlphaGain(0.78, 1);
    const fastGain = inkSpeedAlphaGain(0.22, 1);
    expect(slowGain / fastGain).toBeGreaterThan(1.25);
  });

  it("darkens a slow stroke once the nib has drained a little", () => {
    const drained = 200;
    const slow = inkStrokeAlpha(0.4, 0, false, drained, 1, 1);
    const fast = inkStrokeAlpha(0.4, 0, false, drained, 0, 1);
    expect(slow).toBeGreaterThan(fast);
  });

  it("carries slowness through interpolated stamps", () => {
    const stamps = stampAlongSegment(
      { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 0 },
      { x: 10, y: 0, pressure: NO_PRESSURE, slowness: 1 },
      1,
    );
    expect(stamps.length).toBeGreaterThan(1);
    expect(stamps[stamps.length - 1].slowness).toBeCloseTo(1);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i].slowness!).toBeGreaterThan(stamps[i - 1].slowness!);
    }
  });

  it("leaves a stroke without speed ink exactly as it was", () => {
    const stamps = stampAlongSegment(
      { x: 0, y: 0, pressure: NO_PRESSURE },
      { x: 10, y: 0, pressure: NO_PRESSURE },
      1,
    );
    for (const stamp of stamps) {
      expect(stamp.slowness).toBeUndefined();
    }
  });

  it("pads the export box for the widest the nib can swell to", () => {
    const points = [
      { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 1 },
      { x: 20, y: 0, pressure: NO_PRESSURE, slowness: 1 },
    ];
    const plain = inkOpsBounds([
      { kind: "draw", color: "#000", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false, points },
    ])!;
    const paced = inkOpsBounds([
      { kind: "draw", color: "#000", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false, speedInk: 1, points },
    ])!;
    expect(paced.maxY).toBeGreaterThan(plain.maxY);
  });
});

describe("rasterInk pressure", () => {
  it("clips raw pressure to a personalise ceiling", () => {
    expect(normalizePressure(0.5, 0.5)).toBe(1);
    expect(normalizePressure(0.3, 1)).toBe(0.3);
    expect(normalizePressure(0.9, 0.6)).toBe(1);
    expect(hasStylusPressure(NO_PRESSURE)).toBe(false);
    expect(pointerPressure(0.5, "mouse")).toBe(NO_PRESSURE);
    expect(pointerPressure(0.4, "pen")).toBe(0.4);
  });

  it("combines width and alpha for one sample", () => {
    // No stylus pressure: the tip keeps its geometry and the nib is still full.
    const mouse = inkStrokeStyle(2, 0.75, NO_PRESSURE, 1, true);
    expect(mouse.lineWidth).toBeCloseTo(inkLineWidth(2, 0, false));
    expect(mouse.alpha).toBeCloseTo(1);

    const light = inkStrokeStyle(2, 0.8, 0.25, 1, true);
    const firm = inkStrokeStyle(2, 0.8, 1, 1, true);
    expect(light.alpha).toBeLessThan(firm.alpha);
    expect(light.alpha).toBeGreaterThanOrEqual(INK_PRESSURE_FLOOR);
    expect(light.lineWidth).toBeLessThan(firm.lineWidth);
  });
});

describe("inkStrokeRuns", () => {
  function stroke(points: ScenePoint[], overrides: Partial<InkOp> = {}): InkOp {
    return {
      kind: "draw",
      color: "#000",
      baseWidth: 2,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      points,
      ...overrides,
    } as InkOp;
  }

  it("lays a constant stroke down as a single path", () => {
    const long = Array.from({ length: 400 }, (_, i) => ({
      x: i,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const runs = inkStrokeRuns(stroke(long) as never);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, end: 399 });
  });

  it("covers every segment with no gap between runs", () => {
    const pressures = Array.from({ length: 120 }, (_, i) => ({
      x: i * 3,
      y: 0,
      pressure: 0.05 + (i / 119) * 0.95,
    }));
    const op = stroke(pressures, { pressureSensitive: true }) as never;
    const runs = inkStrokeRuns(op);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0].start).toBe(0);
    expect(runs[runs.length - 1].end).toBe(119);
    for (let i = 1; i < runs.length; i++) {
      // Consecutive runs share a point, so the polylines meet exactly.
      expect(runs[i].start).toBe(runs[i - 1].end);
    }
  });

  it("stays far cheaper than one path per segment", () => {
    // Pressure as a hand actually delivers it after smoothing: a slow swell
    // over the stroke, not per-sample noise.
    const pressures = Array.from({ length: 600 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 60) * 20,
      pressure: 0.45 + Math.sin(i / 190) * 0.3,
    }));
    const runs = inkStrokeRuns(stroke(pressures, { pressureSensitive: true }) as never);
    expect(runs.length).toBeLessThan(60);
  });

  it("resumes from a point index for the live tail", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      x: i,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const runs = inkStrokeRuns(stroke(points) as never, 30);
    expect(runs[0].start).toBe(30);
    expect(runs[runs.length - 1].end).toBe(49);
  });

  it("fades a long stroke on a low dial", () => {
    const points = Array.from({ length: 300 }, (_, i) => ({
      x: i * 4,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const runs = inkStrokeRuns(stroke(points, { maxFullness: 0.15 }) as never);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[runs.length - 1].alpha).toBeLessThan(runs[0].alpha);
    expect(runs[runs.length - 1].alpha).toBeGreaterThanOrEqual(INK_DRY_FLOOR);
  });

  it("holds a full dial solid over the same stroke", () => {
    const points = Array.from({ length: 300 }, (_, i) => ({
      x: i * 4,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const runs = inkStrokeRuns(stroke(points, { maxFullness: 1 }) as never);
    expect(runs).toHaveLength(1);
    expect(runs[0].alpha).toBeGreaterThan(0.95);
  });
});

describe("rasterInk pressure smoothing", () => {
  it("applies a rising sample instantly", () => {
    expect(smoothPressure(0.2, 1)).toBe(1);
    expect(smoothPressure(0.5, 0.8)).toBe(0.8);
  });

  it("smooths a falling sample", () => {
    const next = smoothPressure(1, 0.2);
    expect(next).toBeGreaterThan(0.2);
    expect(next).toBeLessThan(1);
  });

  it("damps a fall more than a rise from the same level", () => {
    const rise = smoothPressure(0.5, 1);
    expect(rise).toBe(1);
    let fall = 1;
    for (let i = 0; i < 4; i += 1) fall = smoothPressure(fall, 0.5);
    expect(fall).toBeGreaterThan(0.5);
    expect(fall).toBeLessThan(1);
    expect(1 - fall).toBeLessThan(1 - 0.5);
  });

  it("holds steady when pressure does not change", () => {
    expect(smoothPressure(0.6, 0.6)).toBeCloseTo(0.6, 10);
  });
});

describe("rasterInk coordinates", () => {
  const viewport = { zoom: 2, scrollX: 10, scrollY: 5 };

  it("round-trips pointer → scene → canvas pixel", () => {
    const rect = { left: 120, top: 80, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    const clientX = 220;
    const clientY = 180;
    const scene = scenePointFromPointer(clientX, clientY, rect, viewport, 0.5, "mouse");
    expect(scene.pressure).toBe(NO_PRESSURE);
    const localX = (scene.x + viewport.scrollX) * viewport.zoom;
    const localY = (scene.y + viewport.scrollY) * viewport.zoom;
    expect(localX).toBeCloseTo(clientX - rect.left);
    expect(localY).toBeCloseTo(clientY - rect.top);
  });

  it("keeps real stylus pressure on pen pointers", () => {
    const rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    const scene = scenePointFromPointer(10, 10, rect, viewport, 0.65, "pen");
    expect(scene.pressure).toBe(0.65);
  });

  it("matches excalidraw viewport formula when canvas aligns with the container", () => {
    const offsetLeft = 120;
    const offsetTop = 80;
    const rect = { left: offsetLeft, top: offsetTop, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    const clientX = 300;
    const clientY = 250;
    const scene = scenePointFromPointer(clientX, clientY, rect, viewport, 0.5, "mouse");
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
    const dense = draw([0, 0], [0.2, 0], [0.4, 0], [0.6, 0], [20, 0]);
    expect(inkStrokesFromOps([dense])).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    ]);
  });

  it("only later erases remove points from a stroke", () => {
    const redrawn = inkStrokesFromOps([erase(5, [50, 0]), draw([0, 0], [50, 0])]);
    const rubbed = inkStrokesFromOps([draw([0, 0], [50, 0]), erase(5, [50, 0])]);
    expect(redrawn).toEqual([{ points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] }]);
    expect(rubbed).toEqual([]);
  });

  it("scales with the board rather than the square of it", () => {
    // One index over every stamp, not one per stroke: 400 strokes against 400
    // erases used to be 160k bucket rebuilds.
    const many: InkOp[] = [];
    for (let i = 0; i < 400; i++) {
      many.push(draw([i * 20, 0], [i * 20 + 10, 0]));
      many.push(erase(3, [i * 20 + 400, 400]));
    }
    const started = Date.now();
    expect(inkStrokesFromOps(many)).toHaveLength(400);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("splits a stroke the eraser cut in half", () => {
    const stroke = draw([0, 0], [20, 0], [40, 0], [60, 0], [80, 0]);
    expect(inkStrokesFromOps([stroke, erase(5, [40, 0])])).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
      { points: [{ x: 60, y: 0 }, { x: 80, y: 0 }] },
    ]);
  });

  it("drops runs too short to be a stroke", () => {
    expect(inkStrokesFromOps([draw([0, 0], [20, 0]), erase(5, [20, 0])])).toEqual([]);
  });
});

describe("ink bounds", () => {
  it("pads the drawn points by the widest line they could carry", () => {
    const bounds = inkOpsBounds([draw([0, 0], [10, 20])]);
    const half = inkLineWidth(2, 0, false) / 2;
    expect(bounds).toEqual({ minX: -half, minY: -half, maxX: 10 + half, maxY: 20 + half });
  });

  it("uses pressure spread for bounds when pressure-sensitive", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#000",
      baseWidth: 2,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: true,
      points: stylusPoints(1, [0, 0], [10, 20]),
    };
    const half = inkLineWidth(2, 1, true) / 2;
    expect(inkOpsBounds([op])).toEqual({
      minX: -half,
      minY: -half,
      maxX: 10 + half,
      maxY: 20 + half,
    });
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
    expect(exportScaleFrom(400, 100, bounds)).toBeNull();
    expect(exportScaleFrom(0, 0, bounds)).toBeNull();
    expect(exportScaleFrom(400, 200, { minX: 5, minY: 5, maxX: 5, maxY: 5 })).toBeNull();
  });
});

/** Enough of a 2D context to check what lands where, without a real canvas. */
function recordingContext() {
  let transform = [1, 0, 0, 1, 0, 0];
  let composite = "source-over";
  let alpha = 1;
  const strokes: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; alpha: number }> = [];
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
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(value: number) {
      alpha = value;
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
      strokes.push({ from: pen, to: map(x, y), alpha });
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
      { from: { x: 20, y: 20 }, to: { x: 60, y: 20 }, alpha: 1 },
    ]);
  });

  it("applies erase and draw in chronological order", () => {
    const { ctx, erased, strokes } = recordingContext();
    paintInkAtScale(
      ctx,
      [erase(4, [110, 60]), draw([110, 60], [130, 60])],
      { x: 100, y: 50 },
      2,
    );
    expect(erased).toEqual([{ x: 20, y: 20, r: 8, composite: "destination-out" }]);
    expect(strokes).toHaveLength(1);
  });

  it("does not let an earlier erase punch through a later stroke", () => {
    const { ctx, erased, strokes } = recordingContext();
    paintInkAtScale(
      ctx,
      [draw([110, 60], [130, 60]), erase(4, [110, 60]), draw([110, 60], [150, 60])],
      { x: 100, y: 50 },
      2,
    );
    expect(erased).toHaveLength(1);
    expect(strokes).toHaveLength(2);
  });

  it("leaves the context ready for the caller to blit onto", () => {
    const { ctx } = recordingContext();
    paintInkAtScale(ctx, [erase(4, [0, 0])], { x: 0, y: 0 }, 1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.globalAlpha).toBe(1);
  });
});

describe("clampExportScale", () => {
  it("leaves an export that already fits alone", () => {
    expect(clampExportScale(2, { minX: 0, minY: 0, maxX: 100, maxY: 400 }, 1000)).toBe(2);
  });

  it("shrinks to the cap when a far-flung stroke stretched the board", () => {
    const bounds = { minX: 0, minY: 0, maxX: 20000, maxY: 500 };
    const scale = clampExportScale(1, bounds, 1000);
    expect(scale).toBeCloseTo(0.05);
    expect((bounds.maxX - bounds.minX) * scale).toBeCloseTo(1000);
  });
});
