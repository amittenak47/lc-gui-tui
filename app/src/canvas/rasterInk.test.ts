import { describe, expect, it } from "vitest";

import {
  applyInkOp,
  applyInkOpFrom,
  applyInkPoolingAtEnds,
  clampExportScale,
  eraserSceneRadius,
  eraserScreenRadius,
  exportScaleFrom,
  hasStylusPressure,
  HIGHLIGHT_WIDTH_SCALE,
  trimHighlightLiftHook,
  inkBaseWidthForZoom,
  inkLineWidth,
  inkOpsBounds,
  inkPressureAlpha,
  inkReservoirAlpha,
  inkStrokeAlpha,
  inkStrokeRuns,
  inkStrokePointStyles,
  inkStrokeStyle,
  inkSlowness,
  inkSpeedAlphaGain,
  inkSpeedWidthGain,
  inkStrokesFromOps,
  hostScrollDx,
  isHostBoundOp,
  paintHostBoundOps,
  ribbonSides,
  INK_DRY_FLOOR,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_ALPHA_BASE,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_SPEED_WIDTH_RANGE,
  INK_PRESSURE_FLOOR,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  INK_TIP_MIN,
  inkDryMid,
  inkDryScale,
  NO_PRESSURE,
  normalizePressure,
  dwellBlotGrowT,
  blotPoolRgb,
  mixBlotAlpha,
  dryWashRgb,
  INK_BLOT_ALPHA_LIFT,
  INK_BLOT_SATURATE,
  INK_BLOT_DARKEN,
  INK_BLOT_END_FLOOR,
  INK_BLOT_SIZE_RANGE,
  blotTicksToFull,
  blotGrowTFromTicks,
  blotDiscPoolT,
  blotRichnessT,
  coalesceRibbonPoints,
  densifyRibbonPoints,
  fillInkRibbon,
  livePaintQueueStart,
  livePaintEvictEnd,
  LIVE_PAINT_QUEUE_NIBS,
  LIVE_PAINT_EVICT_NIBS,
  inkDiscRadii,
  discSealPad,
  isDiscPrimaryPath,
  paintInkAtScale,
  paintInkDisc,
  paintGrainDisc,
  paintInkTerminalCap,
  inkCapRoundness,
  trailingTipClusterStart,
  stampInkBlotHalt,
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
import { paintLiveOp } from "./inkTiles";

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

  it("keeps tip width fixed under stylus pressure (alpha only)", () => {
    const base = inkLineWidth(2, 0, false);
    expect(inkLineWidth(2, 0, true)).toBeCloseTo(base);
    expect(inkLineWidth(2, 0.5, true)).toBeCloseTo(base);
    expect(inkLineWidth(2, 1, true)).toBeCloseTo(base);
  });

  it("gives the finest tip a hairline, and never a negative one", () => {
    // The bottom of the *slider* still lands exactly here.
    expect(inkLineWidth(STROKE_WIDTH_MIN, 0, false)).toBeCloseTo(INK_TIP_MIN);
    /*
     * Below it the tip keeps getting finer instead of clamping back up. Only
     * zoom compensation asks for that (see `inkBaseWidthForZoom`) and clamping
     * is what it exists to defeat: on a page opened at 2× the thinnest nib the
     * writer could pick was twice as thick as the same nib on the scratchpad.
     * How thin a stroke may be *drawn* is `paintedWidth`'s business, and it
     * floors in device pixels wherever the camera is.
     */
    expect(inkLineWidth(0, 0, false)).toBeLessThan(INK_TIP_MIN);
    expect(inkLineWidth(0, 0, false)).toBeGreaterThan(0);
    expect(inkLineWidth(-5, 0, false)).toBeGreaterThan(0);
  });

  /*
   * Nib parity: the dial is in screen pixels, wherever the camera is.
   *
   * Ink is stored in scene units and painted at the board's zoom, which is
   * right — ink belongs to the page. The slider being in those units too was
   * not: a document opens fitted to a reading column and a pad does not, so the
   * same setting wrote a visibly fatter nib on the document.
   */
  describe("inkBaseWidthForZoom", () => {
    const onScreen = (ui: number, zoom: number) =>
      inkLineWidth(inkBaseWidthForZoom(ui, zoom), 0, false) * zoom;

    it("draws the same thickness at any zoom", () => {
      for (const ui of [STROKE_WIDTH_MIN, 2, 6, STROKE_WIDTH_MAX]) {
        const reference = inkLineWidth(ui, 0, false);
        for (const zoom of [0.35, 0.75, 1, 1.6, 3]) {
          expect(onScreen(ui, zoom)).toBeCloseTo(reference, 6);
        }
      }
    });

    it("leaves an unzoomed board exactly where it was", () => {
      for (const ui of [STROKE_WIDTH_MIN, 4, STROKE_WIDTH_MAX]) {
        expect(inkBaseWidthForZoom(ui, 1)).toBeCloseTo(ui, 10);
      }
    });

    it("lets the minimum nib get finer on a zoomed-in page", () => {
      // The reported bug: the finest pen was not fine enough on a document.
      expect(inkBaseWidthForZoom(STROKE_WIDTH_MIN, 2)).toBeLessThan(STROKE_WIDTH_MIN);
      expect(
        inkLineWidth(inkBaseWidthForZoom(STROKE_WIDTH_MIN, 2), 0, false),
      ).toBeLessThan(inkLineWidth(STROKE_WIDTH_MIN, 0, false));
    });

    it("survives a degenerate camera", () => {
      expect(Number.isFinite(inkBaseWidthForZoom(2, 0))).toBe(true);
      expect(inkLineWidth(inkBaseWidthForZoom(2, 0), 0, false)).toBeGreaterThan(0);
    });
  });

  it("still spreads the dial evenly above the finest tip", () => {
    const one = inkLineWidth(1, 0, false);
    const two = inkLineWidth(2, 0, false);
    const three = inkLineWidth(3, 0, false);
    expect(two - one).toBeCloseTo(three - two);
    expect(inkLineWidth(STROKE_WIDTH_MAX, 0, false)).toBeGreaterThan(40);
  });

  /*
   * A highlighter is a chisel, not a nib.
   *
   * Real ones do not modulate, and a translucent stroke that did would band
   * where two passes overlapped — which is the whole reason the reservoir,
   * pressure and speed are all short-circuited rather than merely turned down.
   */
  describe("highlighter", () => {
    const chisel = (pressure: number, consumed: number, slowness: number) =>
      inkStrokeStyle(2, 0.2, pressure, 1, true, consumed, slowness, 1, true);

    it("is one width and one wetness whatever the hand does", () => {
      const start = chisel(0.1, 0, 0);
      const later = chisel(1, 5000, 1);
      expect(later.lineWidth).toBeCloseTo(start.lineWidth);
      expect(later.alpha).toBeCloseTo(start.alpha);
    });

    it("is much wider than the pen it shares a dial with", () => {
      const pen = inkStrokeStyle(2, 1, NO_PRESSURE, 1, false);
      expect(chisel(NO_PRESSURE, 0, INK_SLOWNESS_NEUTRAL).lineWidth).toBeCloseTo(
        pen.lineWidth * HIGHLIGHT_WIDTH_SCALE,
      );
    });

    it("stays translucent enough to read through", () => {
      const alpha = chisel(NO_PRESSURE, 0, INK_SLOWNESS_NEUTRAL).alpha;
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(0.5);
    });

    it("still tracks the width dial", () => {
      const thin = inkStrokeStyle(1, 1, NO_PRESSURE, 1, false, 0, 0.5, 0, true);
      const fat = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 0.5, 0, true);
      expect(fat.lineWidth).toBeGreaterThan(thin.lineWidth);
    });

    it("drops a short reverse tail at lift-off", () => {
      const pts = [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 },
        { x: 80, y: 0, pressure: 0.5 },
        { x: 76, y: 0.5, pressure: 0.2 },
        { x: 72, y: 0, pressure: 0.05 },
      ];
      const kept = trimHighlightLiftHook(pts, 20);
      expect(kept[kept.length - 1]?.x).toBe(80);
    });

    it("keeps a real U-turn that travels farther than the chisel", () => {
      const pts = [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 },
        { x: 0, y: 0, pressure: 0.5 },
      ];
      const kept = trimHighlightLiftHook(pts, 8);
      expect(kept).toHaveLength(3);
    });
  });

  it("stamps denser under pressure than at constant width", () => {
    expect(INK_STEP_FACTOR_PRESSURE).toBeLessThan(INK_STEP_FACTOR);
    expect(INK_STEP_FACTOR_PRESSURE).toBeGreaterThan(0);
  });
});

describe("ink reservoir", () => {
  it("starts every stroke near full, whatever the dial says", () => {
    expect(inkReservoirAlpha(0, 1)).toBe(1);
    expect(inkReservoirAlpha(0, 0.2)).toBeGreaterThan(0.9);
    expect(inkReservoirAlpha(0, 0)).toBeGreaterThan(0.9);
  });

  it("treats fullness 1 as never-dry (pressure-off sentinel)", () => {
    expect(inkReservoirAlpha(1e9, 1)).toBe(1);
  });

  it("still dries at the top of the dial (0.999)", () => {
    expect(inkReservoirAlpha(1e9, 0.999)).toBeCloseTo(INK_DRY_FLOOR, 1);
  });

  it("fades along the stroke, never below the readable floor", () => {
    const dial = 0.4;
    const mid = inkDryMid(dial);
    const early = inkReservoirAlpha(mid * 0.2, dial);
    const late = inkReservoirAlpha(mid + inkDryScale(dial) * 4, dial);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThanOrEqual(INK_DRY_FLOOR);
    expect(inkReservoirAlpha(1e9, dial)).toBeCloseTo(INK_DRY_FLOOR, 1);
  });

  it("is monotone non-increasing as consumed grows", () => {
    const dial = 0.3;
    let prev = inkReservoirAlpha(0, dial);
    for (let c = 10; c <= 4000; c += 10) {
      const next = inkReservoirAlpha(c, dial);
      expect(next).toBeLessThanOrEqual(prev + 1e-12);
      prev = next;
    }
  });

  it("makes a fuller dial last longer at the same distance", () => {
    const consumed = 800;
    expect(inkReservoirAlpha(consumed, 0.9)).toBeGreaterThan(inkReservoirAlpha(consumed, 0.3));
    expect(inkReservoirAlpha(consumed, 0.3)).toBeGreaterThan(inkReservoirAlpha(consumed, 0));
  });

  // Distances in nib widths: letter ~60, word ~400, sentence ~1200, paragraph ~3500.
  const LETTER = 60;
  const WORD = 400;
  const SENTENCE = 1200;
  const PARAGRAPH = 3500;

  it("drops within a word or two on an empty dial", () => {
    // Steep flipped sigmoid: still wet through a letter, dry by two words.
    expect(inkReservoirAlpha(LETTER, 0)).toBeGreaterThan(0.5);
    expect(inkReservoirAlpha(WORD, 0)).toBeLessThan(0.4);
    expect(inkReservoirAlpha(WORD * 2, 0)).toBeCloseTo(INK_DRY_FLOOR, 1);
  });

  it("spends the middle of the dial across a sentence", () => {
    expect(inkReservoirAlpha(WORD, 0.5)).toBeGreaterThan(0.7);
    expect(inkReservoirAlpha(SENTENCE, 0.5)).toBeLessThan(0.85);
    expect(inkReservoirAlpha(SENTENCE * 2, 0.5)).toBeLessThan(0.5);
  });

  it("takes a short paragraph to dry at the top of the dial", () => {
    expect(inkReservoirAlpha(SENTENCE, 0.999)).toBeGreaterThan(0.75);
    expect(inkReservoirAlpha(PARAGRAPH, 0.999)).toBeLessThan(0.7);
    expect(inkReservoirAlpha(PARAGRAPH * 2, 0.999)).toBeLessThan(0.45);
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

  it("scales deposit by ink boldness and clamps to opaque", () => {
    const base = inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 0, 1);
    const triple = inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 0, 3);
    expect(base).toBeCloseTo(1);
    expect(triple).toBeCloseTo(1);
    // Mid-stroke charge so the boost has headroom before the opaque clamp.
    const drained = inkStrokeAlpha(0.3, 0, false, 800, INK_SLOWNESS_NEUTRAL, 0, 1);
    const boosted = inkStrokeAlpha(0.3, 0, false, 800, INK_SLOWNESS_NEUTRAL, 0, 3);
    expect(drained).toBeLessThan(1);
    expect(boosted).toBeCloseTo(Math.min(1, drained * 3));
    expect(boosted).toBeGreaterThan(drained);
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
      expect(inkSpeedAlphaGain(slowness, 1, 0)).toBe(1);
    }
    expect(inkLineWidth(2, 0, false, 1, 0)).toBeCloseTo(inkLineWidth(2, 0, false));
  });

  it("keeps ordinary writing pace the same width as speed-off, even at 5%", () => {
    expect(inkLineWidth(2, 0, false, INK_SLOWNESS_NEUTRAL, 0.05)).toBeCloseTo(
      inkLineWidth(2, 0, false),
    );
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
    const maxSlow = inkStrokeAlpha(1, 0, false, 0, 1, 1, 1, 1);
    expect(maxSlow).toBeLessThanOrEqual(1);
    expect(maxSlow).toBeCloseTo(1);
  });

  it("leaves a standstill wet so pooling can darken, and washes only while moving", () => {
    expect(inkSpeedAlphaGain(1, 1, 1)).toBeCloseTo(1);
    expect(inkSpeedAlphaGain(INK_SLOWNESS_NEUTRAL, 1, 1)).toBeCloseTo(INK_SPEED_ALPHA_BASE);
    expect(inkSpeedAlphaGain(0, 1, 1)).toBeLessThan(INK_SPEED_ALPHA_BASE);
    expect(inkSpeedAlphaGain(0, 1, 1)).toBeGreaterThan(0.55);
  });

  it("reads neutral pace as the speed-alpha base when fade is full", () => {
    expect(inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 1, 1, 1)).toBeCloseTo(
      INK_SPEED_ALPHA_BASE,
    );
  });

  it("keeps full ink at 5% speed when fade is off", () => {
    expect(inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 0.05, 1, 0)).toBe(1);
    expect(inkSpeedAlphaGain(INK_SLOWNESS_NEUTRAL, 0.05, 0)).toBe(1);
  });

  it("washes at fade 100% even when speed ink is off", () => {
    expect(inkSpeedAlphaGain(INK_SLOWNESS_NEUTRAL, 0, 1)).toBeCloseTo(INK_SPEED_ALPHA_BASE);
  });

  it("interpolates the old wash when fade is partial", () => {
    expect(inkSpeedAlphaGain(INK_SLOWNESS_NEUTRAL, 1, 0.5)).toBeCloseTo(
      1 + (INK_SPEED_ALPHA_BASE - 1) * 0.5,
    );
  });

  it("darkens slow strokes more than fast ones at the same alpha gain", () => {
    const slowGain = inkSpeedAlphaGain(0.78, 1, 1);
    const fastGain = inkSpeedAlphaGain(0.22, 1, 1);
    expect(slowGain / fastGain).toBeGreaterThan(1.25);
  });

  it("darkens a slow stroke once the nib has drained a little", () => {
    const drained = 200;
    const slow = inkStrokeAlpha(0.4, 0, false, drained, 1, 1, 1, 1);
    const fast = inkStrokeAlpha(0.4, 0, false, drained, 0, 1, 1, 1);
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
    // Width stays on the tip — pressure only modulates alpha.
    expect(light.lineWidth).toBeCloseTo(firm.lineWidth);
    expect(light.lineWidth).toBeCloseTo(inkLineWidth(2, 0, false));
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

  /*
   * The capsule, and why it survived the first fix.
   *
   * A bead is a width discontinuity: the hand stops dead at a letter join, the
   * slowness track steps rather than ramps, and the runs either side of the
   * step are painted at two very different constant widths. A five-tap box over
   * the point *index* used to be the answer, and it worked until smoothing was
   * turned on — Chaikin inserts points, so the same five taps covered a
   * fraction of the distance they were tuned for. Hence a bead that got worse
   * with the one setting that should have made it better.
   *
   * These tests are written in distance, not samples, so they hold at any
   * point density — which is the property the old filter did not have.
   */
  describe("speed ink slope", () => {
    /** Width at each sample, and how far along the stroke that sample sits. */
    function widthTrackFromStyles(spacing: number) {
      const points = Array.from({ length: 240 }, (_, i) => ({
        x: i * spacing,
        y: 0,
        pressure: NO_PRESSURE,
        slowness: i < 120 ? 0 : 1,
      }));
      const op = stroke(points, { speedInk: 1 }) as never;
      const nib = inkLineWidth(2, 0, false);
      const styles = inkStrokePointStyles(op);
      return styles.map((style, i) => ({
        at: (i * spacing) / nib,
        width: style.lineWidth,
      }));
    }

    function steepest(track: Array<{ at: number; width: number }>) {
      let worst = 0;
      for (let i = 1; i < track.length; i++) {
        const span = track[i].at - track[i - 1].at;
        if (span <= 0) continue;
        worst = Math.max(worst, Math.abs(track[i].width - track[i - 1].width) / span);
      }
      return worst;
    }

    function maxSampleStep(track: Array<{ width: number }>) {
      let worst = 0;
      for (let i = 1; i < track.length; i++) {
        worst = Math.max(worst, Math.abs(track[i].width - track[i - 1].width));
      }
      return worst;
    }

    it("ramps the width instead of stepping it", () => {
      const track = widthTrackFromStyles(1);
      const nib = inkLineWidth(2, 0, false);
      // The step is a full swing of slowness. Spread over the slope limit it
      // cannot arrive in less than a nib width, whatever the sample rate.
      expect(steepest(track)).toBeLessThan(nib);
      // …and it does still arrive: this is a ramp, not a flat line.
      const widths = track.map((sample) => sample.width);
      expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.5);
    });

    it("holds the same slope when smoothing has doubled the point count", () => {
      // Chaikin's effect on this filter, reproduced directly: the same stroke
      // at half the spacing is the same drawing with twice the samples.
      const coarse = steepest(widthTrackFromStyles(1));
      const dense = steepest(widthTrackFromStyles(0.5));
      expect(dense).toBeLessThan(coarse * 1.35 + 1e-6);
    });

    it("never asks for a width a canvas cannot draw", () => {
      // The raw multiplier goes negative past neutral at full strength; the
      // floor is what stops "fast" meaning "one pixel of hairline".
      for (const track of [widthTrackFromStyles(1), widthTrackFromStyles(0.5)]) {
        for (const sample of track) expect(sample.width).toBeGreaterThan(0);
      }
      expect(inkSpeedWidthGain(0, 1)).toBeGreaterThan(0);
      expect(inkSpeedWidthGain(1, 1)).toBeGreaterThan(inkSpeedWidthGain(0, 1));
    });

    it("tapers thick to thin with small per-sample width steps", () => {
      const points = Array.from({ length: 120 }, (_, i) => ({
        x: i,
        y: 0,
        pressure: NO_PRESSURE,
        slowness: 1 - i / 119,
      }));
      const op = stroke(points, { speedInk: 1 }) as never;
      const track = inkStrokePointStyles(op).map((style) => ({ width: style.lineWidth }));
      const nib = inkLineWidth(2, 0, false);
      expect(maxSampleStep(track)).toBeLessThan(nib * 0.12);
      expect(track[0].width).toBeGreaterThan(track[track.length - 1].width);
    });
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
  const path: Array<{ x: number; y: number }> = [];

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
    beginPath() {
      path.length = 0;
    },
    moveTo(x: number, y: number) {
      pen = map(x, y);
      path.length = 0;
      path.push(pen);
    },
    lineTo(x: number, y: number) {
      pen = map(x, y);
      path.push(pen);
    },
    stroke() {
      for (let i = 1; i < path.length; i++) {
        strokes.push({ from: path[i - 1], to: path[i], alpha });
      }
    },
    closePath() {},
    arc(x: number, y: number, r: number) {
      // Draw terminal caps fill (circle or superellipse); only erases are destination-out.
      if (composite !== "destination-out") return;
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

describe("host-bound ink", () => {
  it("shifts paint by the scrollLeft delta", () => {
    const op = {
      ...draw([10, 10], [40, 10]),
      hostKey: 0,
      scrollLeftAtDraw: 20,
    };
    expect(isHostBoundOp(op)).toBe(true);
    expect(hostScrollDx(op, 20)).toBeCloseTo(0);
    expect(hostScrollDx(op, 50)).toBe(-30);
    expect(hostScrollDx(op, 50, 2)).toBe(-30);
    expect(hostScrollDx(draw([0, 0], [1, 1]), 50)).toBe(0);
  });

  it("clips and translates host-bound paint", () => {
    const calls: Array<[string, ...number[]]> = [];
    const ctx = {
      save() {
        calls.push(["save"]);
      },
      restore() {
        calls.push(["restore"]);
      },
      beginPath() {
        calls.push(["beginPath"]);
      },
      rect(x: number, y: number, w: number, h: number) {
        calls.push(["rect", x, y, w, h]);
      },
      clip() {
        calls.push(["clip"]);
      },
      translate(x: number, y: number) {
        calls.push(["translate", x, y]);
      },
      setTransform() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc() {},
      closePath() {},
      globalCompositeOperation: "source-over",
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;

    const op = {
      ...draw([0, 0], [100, 0]),
      hostKey: 0,
      scrollLeftAtDraw: 0,
    };
    const hosts = new Map([
      [0, { bounds: { minX: 10, minY: 0, maxX: 50, maxY: 20 }, scrollLeft: 30 }],
    ]);
    paintHostBoundOps(ctx, [op], hosts, 1);
    expect(calls).toContainEqual(["rect", 10, 0, 40, 20]);
    expect(calls).toContainEqual(["clip"]);
    expect(calls).toContainEqual(["translate", -30, 0]);
  });

  it("leaves page-bound strokes alone", () => {
    const calls: string[] = [];
    const ctx = {
      save() {
        calls.push("save");
      },
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      translate() {},
      setTransform() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc() {},
      closePath() {},
      globalCompositeOperation: "source-over",
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    paintHostBoundOps(ctx, [draw([0, 0], [10, 0])], new Map(), 1);
    expect(calls).toHaveLength(0);
  });

  it("still paints host-bound ops when the host lookup misses (no silent drop)", () => {
    const strokes: string[] = [];
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      translate() {},
      setTransform() {},
      moveTo() {
        strokes.push("moveTo");
      },
      lineTo() {
        strokes.push("lineTo");
      },
      stroke() {
        strokes.push("stroke");
      },
      fill() {},
      arc() {},
      closePath() {},
      globalCompositeOperation: "source-over",
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    const op = {
      ...draw([0, 0], [10, 0]),
      hostKey: 7,
      scrollLeftAtDraw: 40,
    };
    paintHostBoundOps(ctx, [op], new Map(), 1);
    expect(strokes).toContain("stroke");
  });

  it("export paintInkAtScale second-passes host-bound ops when hosts given", () => {
    const calls: Array<[string, ...number[]]> = [];
    const ctx = {
      save() {
        calls.push(["save"]);
      },
      restore() {
        calls.push(["restore"]);
      },
      beginPath() {
        calls.push(["beginPath"]);
      },
      rect(x: number, y: number, w: number, h: number) {
        calls.push(["rect", x, y, w, h]);
      },
      clip() {
        calls.push(["clip"]);
      },
      translate(x: number, y: number) {
        calls.push(["translate", x, y]);
      },
      setTransform() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc() {},
      closePath() {},
      globalCompositeOperation: "source-over",
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    const op = {
      ...draw([0, 0], [40, 0]),
      hostKey: 0,
      scrollLeftAtDraw: 10,
    };
    const hosts = new Map([
      [0, { bounds: { minX: 0, minY: 0, maxX: 80, maxY: 20 }, scrollLeft: 40 }],
    ]);
    paintInkAtScale(ctx, [op], { x: 0, y: 0 }, 1, hosts, 1);
    expect(calls).toContainEqual(["translate", -30, 0]);
  });
});

/** Mock 2D context for ink stroke / cap / join assertions. */
function inkDrawContext() {
  let transform = [1, 0, 0, 1, 0, 0];
  let composite = "source-over";
  let alpha = 1;
  const strokes: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  const caps: Array<{ x: number; y: number; r: number }> = [];
  let fillCount = 0;
  let strokeCount = 0;
  let radialGradients = 0;
  let linearGradients = 0;
  const linearGradientArgs: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const arcRadii: number[] = [];
  const arcSweeps: number[] = [];
  const fillAlphas: number[] = [];
  const fillStyles: string[] = [];
  const colorStops: string[] = [];
  const strokeAlphas: number[] = [];
  const strokeComposites: string[] = [];
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
      strokes.push({ from: pen, to: map(x, y) });
      pen = map(x, y);
    },
    stroke() {
      strokeCount++;
      strokeAlphas.push(alpha);
      strokeComposites.push(composite);
    },
    arc(x: number, y: number, r: number, start = 0, end = Math.PI * 2) {
      arcRadii.push(r);
      arcSweeps.push(end - start);
      if (composite !== "destination-out") {
        caps.push({ ...map(x, y), r: r * transform[0] });
      }
    },
    fill() {
      fillCount++;
      fillAlphas.push(alpha);
      fillStyles.push(String(this.fillStyle));
    },
    createRadialGradient(_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, r1: number) {
      radialGradients++;
      arcRadii.push(r1);
      return {
        addColorStop(_t: number, color: string) {
          colorStops.push(color);
        },
      };
    },
    createLinearGradient(x0 = 0, y0 = 0, x1 = 0, y1 = 0) {
      linearGradients++;
      linearGradientArgs.push({ x0, y0, x1, y1 });
      return {
        addColorStop(_t: number, color: string) {
          colorStops.push(color);
        },
      };
    },
    save() {},
    restore() {},
    rect() {},
    clip() {},
    closePath() {},
    translate() {},
  };

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    strokes,
    caps,
    arcRadii,
    arcSweeps,
    fillAlphas,
    fillStyles,
    colorStops,
    linearGradientArgs,
    strokeAlphas,
    strokeComposites,
    get strokeCount() {
      return strokeCount;
    },
    get fillCount() {
      return fillCount;
    },
    get radialGradients() {
      return radialGradients;
    },
    get linearGradients() {
      return linearGradients;
    },
  };
}

describe("inkDiscRadii / dwell growth", () => {
  it("starts at the nib and grows slowly only when blot and growT are on", () => {
    const tip = 10;
    const contact = inkDiscRadii(tip, 0.55, 0);
    const mid = inkDiscRadii(tip, 0.55, 0.4);
    const full = inkDiscRadii(tip, 1, 1);
    const blotOff = inkDiscRadii(tip, 0, 1);
    expect(contact.outerR).toBeCloseTo(tip);
    expect(mid.outerR).toBeGreaterThan(contact.outerR);
    expect(mid.outerR).toBeLessThan(full.outerR);
    expect(full.outerR).toBeCloseTo(tip * (1 + INK_BLOT_SIZE_RANGE));
    expect(blotOff.outerR).toBeCloseTo(tip);
  });

  it("keeps a hard silhouette (innerR equals outerR)", () => {
    const { outerR, innerR } = inkDiscRadii(10, 1, 1);
    expect(innerR).toBeCloseTo(outerR);
    expect(outerR).toBeGreaterThan(10);
  });

  it("seals a disc by 1 device pixel at any nib", () => {
    expect(discSealPad(4, 1)).toBe(1);
    expect(discSealPad(10, 1)).toBe(1);
    expect(discSealPad(10, 2)).toBe(0.5);
    expect(discSealPad(10, 0)).toBe(0);
  });

  it("uses a hard rim when blot blend is 0", () => {
    const { outerR, innerR } = inkDiscRadii(10, 0, 1);
    expect(innerR).toBeCloseTo(outerR);
    expect(outerR).toBeCloseTo(10);
  });

  it("raises growT slowly as a dwell cluster lengthens", () => {
    const tipR = 4;
    const one = dwellBlotGrowT(points([0, 0]), tipR, 0.5);
    const few = dwellBlotGrowT(
      points([0, 0], [0.1, 0], [0, 0.1], [0.05, 0.05], [0, 0], [0.02, 0], [0, 0.02], [0, 0], [0.01, 0], [0, 0]),
      tipR,
      0.5,
    );
    const manyPts: Array<[number, number]> = [];
    for (let i = 0; i < 50; i++) manyPts.push([0.01 * (i % 3), 0.01 * ((i + 1) % 3)]);
    const many = dwellBlotGrowT(points(...manyPts), tipR, 0.5);
    expect(one).toBe(0);
    expect(few).toBeGreaterThan(0);
    expect(few).toBeLessThan(0.5);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(1);
    expect(blotTicksToFull(1)).toBeGreaterThanOrEqual(48);
    expect(blotTicksToFull(1)).toBeLessThan(120);
    expect(dwellBlotGrowT(points([0, 0], [0.01, 0]), 4, 0)).toBe(0);
    expect(blotGrowTFromTicks(0, 1)).toBe(0);
    expect(blotGrowTFromTicks(blotTicksToFull(1), 1)).toBeCloseTo(1);
  });

  it("does not pool a moving stroke", () => {
    expect(dwellBlotGrowT(points([0, 0], [40, 0], [80, 0]), 4, 0.5)).toBe(0);
  });
});

describe("paintInkDisc tip vs join", () => {
  it("keeps a hard disc when blend is 0", () => {
    const drawCtx = inkDrawContext();
    drawCtx.ctx.fillStyle = "#112233";
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 0, "#112233", true);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(4);
  });

  it("tip mode stays hard even when blend is high (no halo)", () => {
    const drawCtx = inkDrawContext();
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 1, "#112233", false, 1);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(4 * (1 + INK_BLOT_SIZE_RANGE) + 1);
  });

  it("tip mode at growT 0 stays the nib", () => {
    const drawCtx = inkDrawContext();
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 1, "#112233", false, 0);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(4);
  });

  it("adds a 1px seal when blot is pooling", () => {
    const thin = inkDrawContext();
    paintInkDisc(thin.ctx, { x: 0, y: 0 }, 8, 1, 1, 1, "#112233", false, 1);
    expect(thin.arcRadii[0]).toBeCloseTo(4 * (1 + INK_BLOT_SIZE_RANGE) + 1);
    const fat = inkDrawContext();
    paintInkDisc(fat.ctx, { x: 0, y: 0 }, 32, 1, 1, 1, "#112233", false, 1);
    expect(fat.arcRadii[0]).toBeCloseTo(16 * (1 + INK_BLOT_SIZE_RANGE) + 1);
    const noBlot = inkDrawContext();
    paintInkDisc(noBlot.ctx, { x: 0, y: 0 }, 32, 1, 1, 0, "#112233", false, 1);
    expect(noBlot.arcRadii[0]).toBeCloseTo(16);
  });

  it("join mode uses radial fade clamped to nib radius", () => {
    const drawCtx = inkDrawContext();
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 1, "#112233", true);
    expect(drawCtx.radialGradients).toBe(1);
    expect(drawCtx.fillCount).toBe(1);
    expect(Math.max(...drawCtx.arcRadii)).toBeCloseTo(4);
  });

  it("does not cut disc centre alpha when blot blend is 1", () => {
    const drawCtx = inkDrawContext();
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 1, "#112233", true);
    expect(drawCtx.colorStops[0]).toBe("rgba(17, 34, 51, 0.8)");
  });

  it("short-path / tip-down stroke paints the nib, not a pooled blob", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 1,
      speedFade: 0,
      points: points([10, 10]),
    };
    const tipR = inkLineWidth(8, 0, false, INK_SLOWNESS_NEUTRAL, 1) / 2;
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(1);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(tipR);
    expect(inkDiscRadii(tipR, 1, 0).outerR).toBeCloseTo(tipR);
    expect(inkDiscRadii(tipR, 1, 1).outerR).toBeGreaterThan(tipR);
    expect(drawCtx.fillAlphas[0]).toBe(1);
  });

  it("washes legacy speed-ink strokes that never stamped fade", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 1,
      points: points([10, 10]),
    };
    const style = inkStrokePointStyles(op, 0)[0];
    expect(style.dryGain).toBeCloseTo(INK_SPEED_ALPHA_BASE);
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.fillAlphas[0]).toBe(1);
  });

  it("tapers speed-ink width with blot off instead of earthworm runs", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0,
      speedFade: 0,
      points: [
        { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 1 },
        { x: 0, y: 80, pressure: NO_PRESSURE, slowness: 0 },
      ],
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
  });

  it("paints hairline speed ink with stroke() like the normal pen", () => {
    const pts = points([0, 0], [40, 0], [80, 0]);
    const speed = inkDrawContext();
    applyInkOp(
      speed.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: STROKE_WIDTH_MIN,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 1,
        speedBlotBlend: 0,
        speedFade: 0,
        points: pts,
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(speed.strokeCount).toBeGreaterThan(0);

    const pen = inkDrawContext();
    applyInkOp(
      pen.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: STROKE_WIDTH_MIN,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        points: pts,
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(pen.strokeCount).toBeGreaterThan(0);
  });

  it("does not grain-punch a hairline speed-ink stroke", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: STROKE_WIDTH_MIN,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 1,
        speedBlotBlend: 0,
        speedFade: 0,
        grain: 1,
        points: points([0, 0], [40, 0], [80, 0]),
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
    expect(drawCtx.strokeComposites.every((c) => c !== "destination-out")).toBe(true);
  });

  it("does not grain-punch wide speed ink either", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 1,
        speedBlotBlend: 0,
        speedFade: 0,
        grain: 1,
        points: points([0, 0], [40, 0], [80, 0]),
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
    expect(drawCtx.strokeComposites.every((c) => c !== "destination-out")).toBe(true);
  });

  it("paints wide speed ink with stroke() like the size-1 pen", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 1,
        speedBlotBlend: 0,
        speedFade: 0,
        points: points([0, 0], [40, 0], [80, 0]),
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
  });

  it("keeps a wide drying stroke on the ribbon", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 0,
        speedFade: 1,
        points: points([0, 0], [40, 0], [80, 0]),
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(drawCtx.strokeCount).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
  });
});

describe("fillInkRibbon per-quad", () => {
  it("fills a silhouette plus one quad per segment", () => {
    const drawCtx = inkDrawContext();
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    const right = [
      { x: 0, y: 4 },
      { x: 10, y: 4 },
      { x: 20, y: 4 },
    ];
    fillInkRibbon(drawCtx.ctx, left, right, 1);
    expect(drawCtx.fillCount).toBe(3);
  });

  it("still fills self-crossing side polylines (no single winding cancel)", () => {
    const drawCtx = inkDrawContext();
    // Silhouette plus two overlapping quads — quads keep the bow-tie covered.
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const right = [
      { x: 0, y: 4 },
      { x: 10, y: 6 },
      { x: 4, y: 14 },
    ];
    fillInkRibbon(drawCtx.ctx, left, right, 1);
    expect(drawCtx.fillCount).toBe(3);
  });

  it("does not underlay a wash in the stroke-start color", () => {
    const drawCtx = inkDrawContext();
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    const right = [
      { x: 0, y: 4 },
      { x: 10, y: 4 },
      { x: 20, y: 4 },
    ];
    fillInkRibbon(drawCtx.ctx, left, right, 1, [
      "rgb(1, 0, 0)",
      "rgb(2, 0, 0)",
      "rgb(3, 0, 0)",
    ]);
    // Two gradient quads. A fills[0] silhouette would be a third fill.
    expect(drawCtx.fillCount).toBe(2);
    expect(drawCtx.linearGradients).toBe(2);
  });

  it("extends collinear wash gradients into the next chord", () => {
    const drawCtx = inkDrawContext();
    const left = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 40, y: 0 },
    ];
    const right = [
      { x: 0, y: 4 },
      { x: 20, y: 4 },
      { x: 40, y: 4 },
    ];
    fillInkRibbon(drawCtx.ctx, left, right, 1, [
      "rgb(1, 0, 0)",
      "rgb(2, 0, 0)",
      "rgb(3, 0, 0)",
    ]);
    expect(drawCtx.linearGradients).toBe(2);
    const first = drawCtx.linearGradientArgs[0];
    const second = drawCtx.linearGradientArgs[1];
    // Midpoints sit at x=0 and x=20; AA-only overlap would stop near 21.25.
    expect(first.x1).toBeGreaterThan(28);
    expect(second.x0).toBeLessThan(12);
    expect(drawCtx.colorStops).toContain("rgb(3, 0, 0)");
    expect(drawCtx.colorStops).toContain("rgb(1, 0, 0)");
  });

  it("keeps wash overlap tiny at a right-angle corner", () => {
    const drawCtx = inkDrawContext();
    const left = [
      { x: 0, y: -2 },
      { x: 20, y: -2 },
      { x: 22, y: 20 },
    ];
    const right = [
      { x: 0, y: 2 },
      { x: 20, y: 2 },
      { x: 18, y: 20 },
    ];
    fillInkRibbon(drawCtx.ctx, left, right, 1, [
      "rgb(1, 0, 0)",
      "rgb(2, 0, 0)",
      "rgb(3, 0, 0)",
    ]);
    const first = drawCtx.linearGradientArgs[0];
    // Mids at (0,0) and (20,0). A collinear half-chord pad would reach ~30.
    expect(first.x1).toBeLessThan(23);
    expect(first.x1).toBeGreaterThan(20);
  });
});

describe("disc-primary dwell path", () => {
  it("treats a tight near-stationary cluster as disc-primary", () => {
    const cluster = points(
      [10, 10],
      [10.2, 10.1],
      [10.1, 9.9],
      [10.05, 10.05],
      [10.15, 10],
      [10, 10.1],
      [10.1, 10],
    );
    expect(isDiscPrimaryPath(cluster, 8)).toBe(true);
  });

  it("keeps slight pen wiggles disc-primary within about one nib", () => {
    // bbox extent ~7 on nib 8 — previously ribboned at 0.4× nib.
    expect(isDiscPrimaryPath(points([0, 0], [5, 1], [7, 0], [6, -1], [3, 0]), 8)).toBe(true);
  });

  it("keeps a real stroke off the disc-primary path", () => {
    expect(isDiscPrimaryPath(points([0, 0], [40, 0], [80, 10]), 8)).toBe(false);
  });

  it("paints a dwell cluster as discs rather than many ribbon quads", () => {
    const cluster = points(
      [10, 10],
      [10.1, 10],
      [10, 10.1],
      [10.05, 10.05],
      [10.12, 9.98],
      [10.02, 10.08],
      [10.08, 10.02],
      [10, 10],
    );
    const op: InkOp = {
      kind: "draw",
      color: "#000",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0.55,
      points: cluster,
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    // One growing disc stamp — not one fill per ribbon segment.
    expect(drawCtx.fillCount).toBe(1);
  });

  it("does not paint a continuation chunk as a tap disc", () => {
    const wiggle = points([0, 0], [5, 1], [7, 0], [6, -1], [3, 0], [4, 1]);
    expect(isDiscPrimaryPath(wiggle, 8)).toBe(true);
    const op: InkOp = {
      kind: "draw",
      color: "#000",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0.55,
      points: wiggle,
    };
    const asTap = inkDrawContext();
    applyInkOp(asTap.ctx, op, 1);
    expect(asTap.fillCount).toBe(1);

    const cont = inkDrawContext();
    applyInkOp(cont.ctx, op, 1, { capHead: false, capEnd: false });
    expect(cont.fillCount).not.toBe(1);
    expect(cont.linearGradients).toBeGreaterThan(0);
  });
});

describe("livePaintQueueStart", () => {
  it("keeps a short stroke in the live queue", () => {
    expect(livePaintQueueStart(points([0, 0], [1, 0]), 8)).toBe(0);
  });

  it("marks the queue start about 32 nibs behind the tip", () => {
    const nib = 2;
    const pts = Array.from({ length: 80 }, (_, i) => ({
      x: i * 2,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const start = livePaintQueueStart(pts, nib);
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(pts.length - 1);
    let tail = 0;
    for (let i = start; i < pts.length - 1; i++) {
      tail += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    }
    expect(tail).toBeGreaterThanOrEqual(nib * LIVE_PAINT_QUEUE_NIBS - 1e-6);
  });

  it("does not evict until a chunk has fallen off", () => {
    const nib = 2;
    const pts = Array.from({ length: 80 }, (_, i) => ({
      x: i * 2,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    const keep = livePaintQueueStart(pts, nib);
    expect(livePaintEvictEnd(pts, nib, keep - 1)).toBe(keep - 1);
    expect(LIVE_PAINT_EVICT_NIBS).toBe(16);
    expect(livePaintEvictEnd(pts, nib, 0)).toBe(keep);
  });
});

describe("live paint range join", () => {
  it("paints a corner split as a ribbon, not a tap disc", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#00f",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedFade: 1,
      points: points([0, 0], [40, 0], [40, 40], [80, 40], [80, 80]),
    };
    const split = inkDrawContext();
    applyInkOpFrom(split.ctx, op, 0, 1, { capHead: true, capEnd: false, toIndex: 2 });
    applyInkOpFrom(split.ctx, op, 2, 1, { capHead: false, capEnd: true });
    expect(split.fillCount).toBeGreaterThan(1);
  });
});

describe("contact stamp (Phase 1)", () => {
  it("paints a single point as a filled cap, not a semicircle", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, draw([10, 10]), 1);
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcSweeps.some((s) => Math.abs(s - Math.PI) < 1e-6)).toBe(false);
  });

  it("paints a pressure-on cluster of 8 samples inside 0.2× nib as one stamp", () => {
    const cluster = stylusPoints(
      0.75,
      [0, 0],
      [0.4, 0.2],
      [-0.3, 0.1],
      [0.2, -0.4],
      [0.1, 0.3],
      [-0.2, -0.2],
      [0.35, 0],
      [0, -0.15],
    );
    const op: InkOp = {
      kind: "draw",
      color: "#000",
      baseWidth: 8,
      maxFullness: 0.999,
      pressureClip: 1,
      pressureSensitive: true,
      speedInk: 0,
      points: cluster,
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcSweeps.some((s) => Math.abs(s - Math.PI) < 1e-6)).toBe(false);
  });

  it("does not emit two heading-flipped terminal caps at the origin", () => {
    const op: InkOp = {
      kind: "draw",
      color: "#000",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0,
      points: stylusPoints(0.5, [0, 0], [1.2, 0], [-1.1, 0.2]).map((p) => ({
        ...p,
        slowness: INK_SLOWNESS_NEUTRAL,
      })),
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcSweeps.some((s) => Math.abs(s - Math.PI) < 1e-6)).toBe(false);
  });

  it("does not collapse a real two-point line into a single disc", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, draw([0, 0], [50, 0]), 1);
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
  });
});

describe("speed-ink ribbon coalesce / densify / tip split", () => {
  const style = () => inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, INK_SLOWNESS_NEUTRAL, 1);

  it("collapses near-duplicate samples", () => {
    const pts = points(
      [0, 0],
      [0.2, 0],
      [0.3, 0.1],
      [0.25, 0],
      [40, 0],
      [40.1, 0],
      [80, 0],
    );
    const styles = pts.map(() => style());
    const out = coalesceRibbonPoints(pts, styles, 1);
    expect(out.points.length).toBeLessThan(pts.length);
    expect(out.points[0].x).toBeCloseTo(0);
    expect(out.points[out.points.length - 1].x).toBeCloseTo(80);
  });

  it("inserts midpoints on long thick chords", () => {
    const pts = points([0, 0], [40, 0]);
    const styles = pts.map(() => style());
    const out = densifyRibbonPoints(pts, styles, 1);
    expect(out.points.length).toBeGreaterThan(2);
    expect(out.points[0].x).toBeCloseTo(0);
    expect(out.points[out.points.length - 1].x).toBeCloseTo(40);
  });

  it("leaves wash jumps to the paint-time vertex gradient", () => {
    const pts = points([0, 0], [0.4, 0]);
    const styles: ReturnType<typeof style>[] = [
      { ...style(), dryGain: 1 },
      { ...style(), dryGain: 0.5 },
    ];
    const out = densifyRibbonPoints(pts, styles, 1);
    expect(out.points.length).toBe(2);
  });

  it("does not coalesce vertices across a dryGain jump", () => {
    const pts = points([0, 0], [0.3, 0], [40, 0]);
    const styles: ReturnType<typeof style>[] = [
      { ...style(), dryGain: 1 },
      { ...style(), dryGain: 0.5 },
      { ...style(), dryGain: 0.5 },
    ];
    const out = coalesceRibbonPoints(pts, styles, 1);
    expect(out.points.length).toBe(3);
    expect(out.styles[0].dryGain ?? 1).toBeCloseTo(1);
    expect(out.styles[1].dryGain ?? 1).toBeCloseTo(0.5);
  });

  it("finds a trailing tip cluster after a real stroke prefix", () => {
    const pts = points(
      [0, 0],
      [20, 0],
      [40, 0],
      [60, 0],
      [60.2, 0.1],
      [60.1, -0.1],
      [60.15, 0],
      [60, 0.05],
    );
    const start = trailingTipClusterStart(pts, 8);
    expect(start).toBeGreaterThanOrEqual(2);
    expect(start).toBeLessThan(pts.length);
  });

  it("speed-ink stroke paints without soft radial boundary discs", () => {
    // Long enough to leave disc-primary; wiggly tip would previously soft-fade.
    const pts = points(
      [0, 0],
      [15, 2],
      [30, -1],
      [45, 3],
      [60, 0],
      [75, 2],
      [90, 0],
    );
    const op: InkOp = {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 1,
      points: pts,
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    // Soft boundary discs used createRadialGradient; hard silhouette path does not.
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
  });
});

describe("ribbon normal stability", () => {
  function ribbonPolygonArea(
    left: Array<{ x: number; y: number }>,
    right: Array<{ x: number; y: number }>,
  ): number {
    const pts = [...left, ...right.slice().reverse()];
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(area) / 2;
  }

  it("keeps ribbon width vectors from flipping on a sharp turn", () => {
    const pts = points([0, 0], [40, 0], [40, 40]);
    const style = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, INK_SLOWNESS_NEUTRAL, 0);
    const styles = pts.map(() => style);
    const { left, right } = ribbonSides(pts, styles, 1);
    for (let i = 1; i < left.length; i++) {
      const v0x = left[i - 1].x - right[i - 1].x;
      const v0y = left[i - 1].y - right[i - 1].y;
      const v1x = left[i].x - right[i].x;
      const v1y = left[i].y - right[i].y;
      expect(v0x * v1x + v0y * v1y).toBeGreaterThan(0);
    }
  });

  it("needs a neighbor past the cut to match the full-stroke corner section", () => {
    const pts = points([0, 0], [40, 0], [40, 40], [80, 40]);
    const style = inkStrokeStyle(12, 1, NO_PRESSURE, 1, false, 0, INK_SLOWNESS_NEUTRAL, 1);
    const styles = pts.map(() => style);
    const full = ribbonSides(pts, styles, 1);
    const cut = 1;
    const noHalo = ribbonSides(pts.slice(0, cut + 1), styles.slice(0, cut + 1), 1);
    const withHalo = ribbonSides(pts.slice(0, cut + 2), styles.slice(0, cut + 2), 1);
    expect(Math.abs(noHalo.left[cut].x - full.left[cut].x)).toBeGreaterThan(0.5);
    expect(withHalo.left[cut].x).toBeCloseTo(full.left[cut].x, 5);
    expect(withHalo.left[cut].y).toBeCloseTo(full.left[cut].y, 5);
    expect(withHalo.right[cut].x).toBeCloseTo(full.right[cut].x, 5);
    expect(withHalo.right[cut].y).toBeCloseTo(full.right[cut].y, 5);
  });

  it("does not bow-tie on a reverse / retrace path", () => {
    const pts = points([0, 0], [100, 0], [50, 0]);
    const style = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, INK_SLOWNESS_NEUTRAL, 0);
    const styles = pts.map(() => style);
    const { left, right } = ribbonSides(pts, styles, 1);

    for (let i = 0; i < pts.length; i++) {
      const midX = (left[i].x + right[i].x) / 2;
      const midY = (left[i].y + right[i].y) / 2;
      expect(midX).toBeCloseTo(pts[i].x);
      expect(midY).toBeCloseTo(pts[i].y);
    }

    // At the reverse vertex the geometric normal is allowed to flip — not forced
    // to match the outward leg, which would swap left/right and cancel fill.
    expect(left[2].y - pts[2].y).toBeLessThan(0);
    expect(right[2].y - pts[2].y).toBeGreaterThan(0);

    // A bow-tie collapses area; a solid ribbon ~ length × width stays large.
    expect(ribbonPolygonArea(left, right)).toBeGreaterThan(100);
  });
});

describe("drawStrokeFrom / applyInkOp live options", () => {
  it("uses bevel joins on the run path", () => {
    const { ctx } = inkDrawContext();
    applyInkOp(ctx, draw([0, 0], [50, 0], [50, 50]), 1);
    expect(ctx.lineJoin).toBe("bevel");
  });

  it("skips head caps when capHead is false", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, draw([0, 0], [50, 0]), 1, { capHead: false, capEnd: true });
    const afterTail = drawCtx.fillCount;
    applyInkOp(drawCtx.ctx, draw([0, 0], [50, 0]), 1, { capHead: true, capEnd: true });
    expect(drawCtx.fillCount).toBeGreaterThan(afterTail);
    const afterBoth = drawCtx.fillCount;
    applyInkOp(drawCtx.ctx, draw([0, 0], [50, 0]), 1, { capHead: false, capEnd: false });
    expect(drawCtx.fillCount).toBe(afterBoth);
  });

  it("paints constant-width and speed-ink strokes without incremental tail paint", () => {
    const constant = inkDrawContext();
    applyInkOp(
      constant.ctx,
      draw([0, 0], [50, 0], [50, 50]),
      1,
      { capHead: false, capEnd: false },
    );
    expect(constant.strokeCount).toBeGreaterThan(0);

    const speed = inkDrawContext();
    applyInkOp(
      speed.ctx,
      {
        kind: "draw",
        color: "#000",
        baseWidth: 4,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0.5,
        speedBlotBlend: 0.55,
        points: stylusPoints(0.5, [0, 0], [50, 0], [50, 50]).map((p) => ({
          ...p,
          slowness: INK_SLOWNESS_NEUTRAL,
        })),
      },
      1,
      { capHead: false, capEnd: false },
    );
    expect(speed.fillCount).toBeGreaterThan(0);
  });

  it("seals run ends without half-disc hairline caps", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, draw([0, 0], [50, 0]), 1);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
    expect(drawCtx.arcSweeps.some((s) => Math.abs(s - Math.PI) < 1e-6)).toBe(false);
  });

  it("paintLiveOp rounds both ends of a long open stroke", () => {
    const viewport = {
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
      offsetLeft: 0,
      offsetTop: 0,
      width: 100,
      height: 100,
    };
    const drawCtx = inkDrawContext();
    paintLiveOp(drawCtx.ctx, draw([0, 0], [50, 0], [100, 0]), viewport, 1, null);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(2);
    expect(drawCtx.arcSweeps.some((s) => Math.abs(s - Math.PI) < 1e-6)).toBe(false);
  });

  it("paintLiveOp gives short strokes a round head", () => {
    const viewport = {
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
      offsetLeft: 0,
      offsetTop: 0,
      width: 100,
      height: 100,
    };
    const drawCtx = inkDrawContext();
    paintLiveOp(drawCtx.ctx, draw([0, 0], [5, 0]), viewport, 1, null);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
  });
});

describe("stochastic endcaps", () => {
  it("is stable for the same origin and salt", () => {
    const origin = { x: 12.3, y: 45.6 };
    expect(inkCapRoundness(origin, 1)).toBe(inkCapRoundness(origin, 1));
    expect(inkCapRoundness(origin, 1)).not.toBe(inkCapRoundness(origin, 2));
  });

  it("spreads from nearly rectangular to round across origins", () => {
    const values = Array.from({ length: 48 }, (_, i) =>
      inkCapRoundness({ x: i * 17, y: i * 11 }, 1),
    );
    expect(Math.min(...values)).toBeLessThan(0.35);
    expect(Math.max(...values)).toBeGreaterThan(0.85);
  });

  it("pulls toward square under hard stylus pressure", () => {
    const origin = { x: 100, y: 200 };
    const light = inkCapRoundness(origin, 1, 0.1, true);
    const hard = inkCapRoundness(origin, 1, 0.95, true);
    expect(hard).toBeLessThan(light);
    expect(hard).toBeLessThan(0.45);
  });

  it("paints a full circle at roundness 1 and a superellipse below the circle threshold", () => {
    const round = inkDrawContext();
    paintInkTerminalCap(round.ctx, { x: 0, y: 0 }, 5, 0, 1);
    expect(round.fillCount).toBe(1);
    expect(round.arcSweeps[0]).toBeCloseTo(Math.PI * 2);

    const square = inkDrawContext();
    paintInkTerminalCap(square.ctx, { x: 0, y: 0 }, 5, 0, 0.2);
    expect(square.fillCount).toBe(1);
    expect(square.arcSweeps).toHaveLength(0);
    expect(square.strokes.length).toBeGreaterThan(8);
  });
});

describe("stroke start cap", () => {
  it("keeps a square start cap on the stroke heading at the nib width", () => {
    let origin = { x: 0, y: 0 };
    let found = false;
    for (let i = 0; i < 80; i++) {
      const o = { x: i * 19, y: i * 5 };
      if (inkCapRoundness(o, 1) < 0.82) {
        origin = o;
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    const half = inkLineWidth(8, 0, false) / 2;
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#000",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 1,
        speedBlotBlend: 0,
        boldness: 1,
        points: points([origin.x, origin.y], [origin.x + 40, origin.y]),
      },
      1,
    );
    const ys = drawCtx.strokes.flatMap((s) => [s.from.y, s.to.y]);
    expect(ys.length).toBeGreaterThan(0);
    const maxAcross = Math.max(...ys.map((y) => Math.abs(y - origin.y)));
    expect(maxAcross).toBeLessThanOrEqual(half * 1.2);
  });
});

describe("grain and blot pooling (Phase 2)", () => {
  it("paints grain 0 as one hard arc", () => {
    const drawCtx = inkDrawContext();
    paintGrainDisc(drawCtx.ctx, { x: 10, y: 10 }, 5, 0, 1, "#000");
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.arcSweeps[0]).toBeCloseTo(Math.PI * 2);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(5);
  });

  it("keeps a grain 0.5 silhouette within about 1.1× tip", () => {
    const drawCtx = inkDrawContext();
    const tip = 8;
    const at = { x: 20, y: 30 };
    paintGrainDisc(drawCtx.ctx, at, tip, 0.5, 1, "#000");
    expect(drawCtx.fillCount).toBe(1);
    expect(drawCtx.strokeCount).toBeGreaterThan(0);
    const extent = Math.max(
      ...drawCtx.caps.map((c) => Math.hypot(c.x - at.x, c.y - at.y) + c.r),
    );
    expect(extent).toBeLessThanOrEqual(tip * 1.1 + 1e-6);
  });

  it("etches a fine paper tooth with varied transparency, off the disc centre", () => {
    const at = { x: 20, y: 30 };
    const tip = 8;
    const drawCtx = inkDrawContext();
    paintGrainDisc(drawCtx.ctx, at, tip, 0.8, 1, "#000");
    expect(drawCtx.strokeComposites.every((c) => c === "destination-out")).toBe(true);
    expect(Math.min(...drawCtx.strokeAlphas)).toBeGreaterThan(0);
    expect(Math.max(...drawCtx.strokeAlphas)).toBeLessThan(0.5);
    expect(Math.max(...drawCtx.strokeAlphas)).toBeGreaterThan(
      Math.min(...drawCtx.strokeAlphas),
    );
    const distToLine = (
      p: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
      return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
    };
    const farthest = Math.max(
      ...drawCtx.strokes.map((s) => distToLine(at, s.from, s.to)),
    );
    expect(farthest).toBeGreaterThan(tip * 0.2);
    const longest = Math.max(
      ...drawCtx.strokes.map((s) => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y)),
    );
    expect(longest).toBeLessThan(tip * 0.22);
  });

  it("scatters grain across a stroke instead of the centerline", () => {
    const textured = inkDrawContext();
    applyInkOp(
      textured.ctx,
      {
        kind: "draw",
        color: "#808080",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        grain: 0.8,
        points: points([0, 0], [40, 0]),
      },
      1,
    );
    const offAxis = textured.strokes.filter(
      (s) => Math.abs((s.from.y + s.to.y) / 2) > 0.8,
    );
    expect(offAxis.length).toBeGreaterThan(0);
  });

  it("etches grain through the trail, not only the caps", () => {
    const textured = inkDrawContext();
    applyInkOp(
      textured.ctx,
      {
        kind: "draw",
        color: "#808080",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        grain: 0.8,
        points: points([0, 0], [80, 0]),
      },
      1,
    );
    const mid = textured.strokes.filter((s) => {
      const x = (s.from.x + s.to.x) / 2;
      return x > 20 && x < 60;
    });
    expect(mid.length).toBeGreaterThan(30);
    const offAxis = mid.filter((s) => Math.abs((s.from.y + s.to.y) / 2) > 0.8);
    expect(offAxis.length).toBeGreaterThan(0);
  });

  it("does not overshoot the nib when blot is 0", () => {
    const tip = 6;
    expect(inkDiscRadii(tip, 0, 0).outerR).toBeCloseTo(tip);
    expect(inkDiscRadii(tip, 0, 1).outerR).toBeCloseTo(tip);
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#000",
        baseWidth: 12,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedBlotBlend: 0,
        boldness: 1,
        points: points([0, 0]),
      },
      1,
    );
    const half = inkLineWidth(12, 0, false) / 2;
    for (const cap of drawCtx.caps) {
      expect(cap.r).toBeLessThanOrEqual(half + 1e-6);
    }
  });

  it("grows past the nib at blot 100% and growT 1, with or without grain", () => {
    const tip = 10;
    const grown = inkDiscRadii(tip, 1, 1).outerR;
    expect(grown).toBeCloseTo(tip * (1 + INK_BLOT_SIZE_RANGE));
    const hard = inkDrawContext();
    paintGrainDisc(hard.ctx, { x: 0, y: 0 }, tip, 0, 1, "#000", 1, 1);
    expect(hard.arcRadii[0]).toBeCloseTo(grown);
    const textured = inkDrawContext();
    paintGrainDisc(textured.ctx, { x: 0, y: 0 }, tip, 0.5, 1, "#000", 1, 1);
    expect(Math.max(...textured.arcRadii)).toBeGreaterThan(tip);
    expect(textured.strokeCount).toBeGreaterThan(0);
  });

  it("does not read a missing grain field as the live dial", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, draw([4, 4]), 1);
    expect(drawCtx.fillCount).toBe(1);
  });

  it("pools as a richer, less transparent deposit of the same colour", () => {
    const grey = blotPoolRgb("#808080", 1);
    const greyPlain = blotPoolRgb("#808080", 0);
    expect(grey.r + grey.g + grey.b).toBeLessThan(greyPlain.r + greyPlain.g + greyPlain.b);
    const mint = blotPoolRgb("#40c0a0", 1);
    const plain = blotPoolRgb("#40c0a0", 0);
    expect(mint.r + mint.g + mint.b).toBeLessThan(plain.r + plain.g + plain.b);
    expect(mint.g - mint.r).toBeGreaterThan(plain.g - plain.r);
    expect(mixBlotAlpha(1, 1)).toBeCloseTo(1);
    expect(mixBlotAlpha(0.5, 1)).toBeGreaterThan(0.5);
    expect(mixBlotAlpha(0.5, 1)).toBeCloseTo(0.5 + 0.5 * INK_BLOT_ALPHA_LIFT);
    expect(INK_BLOT_SATURATE).toBeGreaterThan(0.48);
    expect(INK_BLOT_DARKEN).toBeGreaterThan(0.28);
    expect(blotDiscPoolT(0, 1, INK_SLOWNESS_NEUTRAL)).toBeCloseTo(INK_BLOT_END_FLOOR);
    expect(blotRichnessT(1, 1, 1, 1)).toBeGreaterThan(blotRichnessT(1, 1, 1, 0.3));
    const lightStop = blotPoolRgb("#40c0a0", blotRichnessT(1, 1, 1, 0.3));
    const firmStop = blotPoolRgb("#40c0a0", blotRichnessT(1, 1, 1, 1));
    expect(firmStop.r + firmStop.g + firmStop.b).toBeLessThan(
      lightStop.r + lightStop.g + lightStop.b,
    );

    const tip = 8;
    const rest = inkDrawContext();
    paintInkDisc(rest.ctx, { x: 0, y: 0 }, tip * 2, 0.6, 1, 1, "#40c0a0", false, 1, 1);
    const grown = inkDrawContext();
    paintInkDisc(grown.ctx, { x: 0, y: 0 }, tip * 2, 0.6, 1, 0, "#40c0a0", false, 1, 1);
    expect(rest.arcRadii[0]).toBeGreaterThan(grown.arcRadii[0]);
    expect(rest.fillAlphas[0]).toBeGreaterThan(grown.fillAlphas[0]);
  });

  it("keeps trail width when speed ink is off, even with blot pooling", () => {
    const rest = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 1, 0, false, 1, 0, 1);
    const moving = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 0.5, 0, false, 1, 0, 1);
    expect(rest.lineWidth).toBeCloseTo(moving.lineWidth);
    expect(rest.blotPool ?? 0).toBe(0);
    expect(moving.blotPool ?? 0).toBe(0);
  });

  it("widens the trail at rest when speed ink and blot are both on", () => {
    const rest = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 1, 1, false, 1, 0, 1);
    const moving = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 0.5, 1, false, 1, 0, 1);
    expect(rest.lineWidth).toBeGreaterThan(moving.lineWidth);
    expect(rest.blotPool ?? 0).toBe(0);
    expect(moving.blotPool ?? 0).toBe(0);
  });

  it("textures a moving stroke when grain is on", () => {
    const hard = inkDrawContext();
    applyInkOp(
      hard.ctx,
      {
        kind: "draw",
        color: "#808080",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        grain: 0,
        points: points([0, 0], [40, 0]),
      },
      1,
    );
    const textured = inkDrawContext();
    applyInkOp(
      textured.ctx,
      {
        kind: "draw",
        color: "#808080",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        grain: 0.8,
        points: points([0, 0], [40, 0]),
      },
      1,
    );
    expect(textured.strokeCount).toBeGreaterThan(hard.strokeCount);
    expect(textured.fillCount).toBe(hard.fillCount);
  });

  it("paints pooling-only moving strokes as a ribbon, not earthworm runs", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#112233",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 1,
        points: points([0, 0], [80, 0]),
      },
      1,
    );
    expect(drawCtx.strokeCount).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(3);
  });

  it("paints drying-only strokes as a washed ribbon with a vertex gradient", () => {
    const rest = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 1, 0, false, 1, 1);
    const moving = inkStrokeStyle(8, 1, NO_PRESSURE, 1, false, 0, 0.2, 0, false, 1, 1);
    expect(rest.dryGain ?? 1).toBeCloseTo(1);
    expect(moving.dryGain ?? 1).toBeLessThan(0.85);
    expect(rest.blotPool ?? 0).toBe(0);

    const washed = dryWashRgb("#c41e3a", 0.5);
    const wet = dryWashRgb("#c41e3a", 1);
    expect(washed.r).toBeGreaterThan(wet.r);
    expect(washed.g).toBeGreaterThan(wet.g);

    const drawCtx = inkDrawContext();
    applyInkOp(
      drawCtx.ctx,
      {
        kind: "draw",
        color: "#c41e3a",
        baseWidth: 8,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 0,
        speedFade: 1,
        points: [
          { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 1 },
          { x: 40, y: 0, pressure: NO_PRESSURE, slowness: 0.5 },
          { x: 80, y: 0, pressure: NO_PRESSURE, slowness: 0 },
        ],
      },
      1,
    );
    expect(drawCtx.strokeCount).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(3);
    expect(drawCtx.linearGradients).toBeGreaterThan(0);
  });

  it("grows ribbon tip width from blotTipGrow on a moving stroke", () => {
    const pts = points([0, 0], [40, 0], [80, 0]);
    const base = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      points: pts,
    };
    const styles = inkStrokePointStyles({ ...base, blotTipGrow: 0 }, 0);
    expect(styles[1].blotPool ?? 0).toBe(0);
    const nibStyles = applyInkPoolingAtEnds(styles, { ...base, blotTipGrow: 0 }, pts, 0);
    const grownStyles = applyInkPoolingAtEnds(styles, { ...base, blotTipGrow: 1 }, pts, 0);
    expect(nibStyles[1].lineWidth).toBeCloseTo(grownStyles[1].lineWidth);
    expect(grownStyles[grownStyles.length - 1].lineWidth).toBeGreaterThan(
      nibStyles[nibStyles.length - 1].lineWidth,
    );

    const ribNib = ribbonSides(pts, nibStyles, 1);
    const ribGrown = ribbonSides(pts, grownStyles, 1);
    const last = pts.length - 1;
    const halfNib =
      Math.hypot(
        ribNib.left[last].x - ribNib.right[last].x,
        ribNib.left[last].y - ribNib.right[last].y,
      ) / 2;
    const halfGrown =
      Math.hypot(
        ribGrown.left[last].x - ribGrown.right[last].x,
        ribGrown.left[last].y - ribGrown.right[last].y,
      ) / 2;
    expect(halfGrown).toBeGreaterThan(halfNib);
  });

  it("grows a halted pooling tip past the nib with Speed ink off", () => {
    const pts = points([0, 0], [40, 0], [80, 0], [80.05, 0], [80, 0.08], [80.04, 0.02]);
    const op = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 1,
      points: pts,
    };
    const styles = inkStrokePointStyles(op, 0);
    const pooled = applyInkPoolingAtEnds(styles, op, pts, 0);
    expect(pooled[pooled.length - 1].lineWidth).toBeGreaterThan(pooled[1].lineWidth);
    expect(pooled[1].lineWidth).toBeCloseTo(styles[1].lineWidth);

    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.strokeCount).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(3);
  });

  it("applyInkPoolingAtEnds widens only head and tip when grow is full", () => {
    const dwell = points([0, 0], [0.1, 0], [0.05, 0.08], [0.08, 0.02], [40, 0], [80, 0]);
    const op = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 1,
      points: dwell,
    };
    const styles = inkStrokePointStyles(op, 0);
    const pooled = applyInkPoolingAtEnds(styles, op, dwell, 0);
    expect(pooled[0].lineWidth).toBeGreaterThan(styles[0].lineWidth);
    expect(pooled[pooled.length - 1].lineWidth).toBeGreaterThan(
      styles[styles.length - 1].lineWidth,
    );
    const mid = pooled.findIndex((_, i) => dwell[i].x === 40);
    expect(mid).toBeGreaterThan(0);
    expect(pooled[mid].lineWidth).toBeCloseTo(styles[mid].lineWidth);
  });

  it("keeps endpoints richer than the trail without a hold or extra width", () => {
    const pts = points([0, 0], [40, 0], [80, 0]);
    const op = {
      kind: "draw" as const,
      color: "#c41e3a",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 0,
      points: pts,
    };
    const styles = inkStrokePointStyles(op, 0);
    const pooled = applyInkPoolingAtEnds(styles, op, pts, 0);
    expect(pooled[0].blotPool ?? 0).toBeGreaterThanOrEqual(INK_BLOT_END_FLOOR - 1e-6);
    expect(pooled[pooled.length - 1].blotPool ?? 0).toBeGreaterThanOrEqual(
      INK_BLOT_END_FLOOR - 1e-6,
    );
    expect(pooled[1].blotPool ?? 0).toBeLessThan(pooled[0].blotPool ?? 0);
    expect(pooled[0].lineWidth).toBeCloseTo(styles[0].lineWidth);
    expect(pooled[pooled.length - 1].lineWidth).toBeCloseTo(styles[styles.length - 1].lineWidth);
  });

  it("keeps a start hold on the ribbon when the nib moves away", () => {
    const pts = points([0, 0], [40, 0], [80, 0]);
    const base = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 0,
      points: pts,
    };
    const styles = inkStrokePointStyles(base, 0);
    const pooled = applyInkPoolingAtEnds(
      styles,
      { ...base, blotHalts: [{ x: 0, y: 0, grow: 1, pressure: NO_PRESSURE }] },
      pts,
      0,
    );
    expect(pooled[0].lineWidth).toBeGreaterThan(styles[0].lineWidth);
    expect(pooled[pooled.length - 1].lineWidth).toBeCloseTo(styles[styles.length - 1].lineWidth);
  });

  it("lerps drying wash through a pool falloff instead of snapping it off", () => {
    const pts = [
      { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 0.2 },
      { x: 40, y: 0, pressure: NO_PRESSURE, slowness: 0.2 },
      { x: 80, y: 0, pressure: NO_PRESSURE, slowness: 0.2 },
      { x: 120, y: 0, pressure: NO_PRESSURE, slowness: 1 },
    ];
    const op = {
      kind: "draw" as const,
      color: "#c41e3a",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      speedFade: 1,
      blotTipGrow: 1,
      points: pts,
    };
    const styles = inkStrokePointStyles(op, 0);
    const trailDry = styles[0].dryGain ?? 1;
    expect(trailDry).toBeLessThan(0.9);
    const pooled = applyInkPoolingAtEnds(styles, op, pts, 0);
    expect(pooled[0].dryGain ?? 1).toBeCloseTo(trailDry, 2);
    expect(pooled[pooled.length - 1].dryGain ?? 1).toBeCloseTo(1);
  });

  it("applies pressure to pooling richness at a halted tip", () => {
    const lightPts = [
      { x: 0, y: 0, pressure: 0.25, slowness: 1 },
      { x: 40, y: 0, pressure: 0.25, slowness: 1 },
    ];
    const firmPts = [
      { x: 0, y: 0, pressure: 0.95, slowness: 1 },
      { x: 40, y: 0, pressure: 0.95, slowness: 1 },
    ];
    const base = {
      kind: "draw" as const,
      color: "#40c0a0",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: true,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 1,
    };
    const light = applyInkPoolingAtEnds(
      inkStrokePointStyles({ ...base, points: lightPts }, 0),
      { ...base, points: lightPts },
      lightPts,
      0,
    );
    const firm = applyInkPoolingAtEnds(
      inkStrokePointStyles({ ...base, points: firmPts }, 0),
      { ...base, points: firmPts },
      firmPts,
      0,
    );
    expect(firm[firm.length - 1].blotPool ?? 0).toBeGreaterThan(
      light[light.length - 1].blotPool ?? 0,
    );
  });

  it("stampInkBlotHalt merges a second hold at the same spot", () => {
    const dest: { blotHalts?: { x: number; y: number; grow: number }[] } = {};
    stampInkBlotHalt(dest, { x: 40, y: 10, pressure: NO_PRESSURE }, 0.4);
    stampInkBlotHalt(dest, { x: 40.2, y: 10.1, pressure: NO_PRESSURE }, 0.7);
    expect(dest.blotHalts).toHaveLength(1);
    expect(dest.blotHalts![0].grow).toBeCloseTo(0.7);
  });

  it("flares ribbon width at a mid-stroke halt instead of a separate disc", () => {
    const pts = points([0, 0], [40, 0], [80, 0]);
    const base = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 0,
      points: pts,
    };
    const styles = inkStrokePointStyles(base, 0);
    const pooled = applyInkPoolingAtEnds(
      styles,
      { ...base, blotHalts: [{ x: 40, y: 0, grow: 1, pressure: NO_PRESSURE }] },
      pts,
      0,
    );
    expect(pooled[1].lineWidth).toBeGreaterThan(pooled[0].lineWidth);
    expect(pooled[1].lineWidth).toBeGreaterThan(styles[1].lineWidth);
    expect(pooled[0].lineWidth).toBeCloseTo(styles[0].lineWidth);

    const plain = inkDrawContext();
    applyInkOp(plain.ctx, base, 1);
    const halted = inkDrawContext();
    applyInkOp(
      halted.ctx,
      {
        ...base,
        blotHalts: [{ x: 40, y: 0, grow: 1, pressure: NO_PRESSURE }],
      },
      1,
    );
    expect(halted.radialGradients).toBe(0);
    expect(halted.strokeCount).toBe(plain.strokeCount);
    expect(halted.fillCount).toBeGreaterThanOrEqual(plain.fillCount);
  });

  it("caps a pooled moving stroke at the flared ribbon width, not a second disc", () => {
    const pts = points([0, 0], [80, 0]);
    const op = {
      kind: "draw" as const,
      color: "#112233",
      baseWidth: 12,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      blotTipGrow: 1,
      points: pts,
    };
    const densified = densifyRibbonPoints(pts, inkStrokePointStyles(op, 0), 1);
    const pooled = applyInkPoolingAtEnds(densified.styles, op, densified.points, 0);
    const tipHalf = pooled[pooled.length - 1].lineWidth / 2;
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    const plain = inkDrawContext();
    applyInkOp(plain.ctx, { ...op, blotTipGrow: 0 }, 1);
    expect(drawCtx.arcRadii.length).toBe(plain.arcRadii.length);
    expect(drawCtx.arcRadii.every((r) => r <= tipHalf + 1e-6)).toBe(true);
  });
});
