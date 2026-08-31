import { describe, expect, it } from "vitest";

import {
  applyInkOp,
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
  inkSpeedBodyShape,
  inkStrokesFromOps,
  hostScrollDx,
  isHostBoundOp,
  paintHostBoundOps,
  ribbonSides,
  INK_DRY_FLOOR,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_SPEED_WIDTH_RANGE,
  INK_SPEED_MIN_WIDTH_GAIN,
  inkSpeedPaceUnit,
  INK_PRESSURE_FLOOR,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  INK_TIP_MIN,
  inkDryMid,
  inkDryScale,
  NO_PRESSURE,
  normalizePressure,
  dwellBlotGrowT,
  coalesceRibbonPoints,
  densifyRibbonPoints,
  fillInkRibbon,
  inkDiscRadii,
  isDiscPrimaryPath,
  paintInkAtScale,
  paintInkDisc,
  trailingTipClusterStart,
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

  it("does nothing when Speed ink is off, even if body accent is 100%", () => {
    for (const slowness of [0, 0.25, 0.5, 0.75, 1]) {
      expect(inkSpeedWidthGain(slowness, 0, 1)).toBe(1);
    }
  });

  /*
   * Body is the endpoint tuner, and it is bipolar.
   *
   * It used to scale `sin(pi * paceUnit)`, which peaks halfway between
   * ordinary pace and a stop and is exactly zero *at* the stop — so the dial
   * could not touch the rest blob at all, which is the one thing the control
   * is labelled as doing ("left kills the round rest blob, right fattens the
   * ends"). Pen-down and lift are the slowest samples on the curve, so the
   * shape it scales is rest weight.
   */
  /*
   * The guarantee that lets Body coexist with the one-curve pen: at 0 the body
   * term vanishes and the gain is exactly `1 + RANGE * strength * paceUnit`,
   * the single pace curve, to the bit. Restoring the dial cannot move the pen
   * unless someone deliberately turns it.
   */
  it("is the single pace curve exactly when Body is 0", () => {
    for (const slowness of [0, 0.25, INK_SLOWNESS_NEUTRAL, 0.75, 1]) {
      for (const strength of [0, 0.05, 0.45, 1]) {
        const oneCurve =
          strength <= 0
            ? 1
            : Math.max(
                INK_SPEED_MIN_WIDTH_GAIN,
                1 + INK_SPEED_WIDTH_RANGE * strength * inkSpeedPaceUnit(slowness),
              );
        expect(inkSpeedWidthGain(slowness, strength, 0)).toBeCloseTo(oneCurve, 12);
      }
    }
  });

  it("tunes the rest blob at the endpoints, in both directions", () => {
    const plain = inkSpeedWidthGain(1, 0.05, 0);
    expect(inkSpeedWidthGain(1, 0.05, 1)).toBeGreaterThan(plain);
    expect(inkSpeedWidthGain(1, 0.05, -1)).toBeLessThan(plain);
  });

  /*
   * Body is an axis, not a scale: right piles weight onto the terminals, left
   * takes it off them and puts it into the body of the letter. Rest weight
   * alone could only ever reach the ends, which is the thing the dial is
   * named for and could not touch.
   */
  it("moves weight to the middle on the left and to the ends on the right", () => {
    const mid = INK_SLOWNESS_NEUTRAL;
    const plainMid = inkSpeedWidthGain(mid, 0.5, 0);
    const plainEnd = inkSpeedWidthGain(1, 0.5, 0);
    expect(inkSpeedWidthGain(mid, 0.5, -1)).toBeGreaterThan(plainMid);
    expect(inkSpeedWidthGain(1, 0.5, -1)).toBeLessThan(plainEnd);
    expect(inkSpeedWidthGain(1, 0.5, 1)).toBeGreaterThan(plainEnd);
    // A sprint is neither end nor middle, so nothing there moves.
    for (const body of [-1, 0, 1]) {
      expect(inkSpeedWidthGain(0, 0.5, body)).toBeCloseTo(
        inkSpeedWidthGain(0, 0.5, 0),
      );
    }
  });

  it("leaves the middle alone on the right of centre", () => {
    const mid = INK_SLOWNESS_NEUTRAL;
    expect(inkSpeedWidthGain(mid, 0.5, 1)).toBeCloseTo(
      inkSpeedWidthGain(mid, 0.5, 0),
    );
  });

  it("scales body accent only while Speed ink is on", () => {
    const half = inkSpeedWidthGain(1, 0.05, 0.5);
    const full = inkSpeedWidthGain(1, 0.05, 1);
    expect(full).toBeGreaterThan(half);
    for (const body of [-1, 0, 1]) {
      expect(inkSpeedWidthGain(1, 0, body)).toBe(1);
    }
  });



  it("keeps full ink at 5% speed when fade is off", () => {
    expect(inkStrokeAlpha(1, 0, false, 0, INK_SLOWNESS_NEUTRAL, 0.05, 1, 0)).toBe(1);
    expect(inkSpeedAlphaGain(INK_SLOWNESS_NEUTRAL, 0.05, 0)).toBe(1);
  });




  /*
   * Pace is out of the alpha entirely now. It asserted that a drained nib went
   * darker when moving slowly, which was the pace wash reading the same signal
   * Speed ink already owns; the reservoir answers to distance alone.
   */
  it("drains the same at a given distance however fast the nib got there", () => {
    const drained = 200;
    const slow = inkStrokeAlpha(0.4, 0, false, drained, 1, 1, 1, 1);
    const fast = inkStrokeAlpha(0.4, 0, false, drained, 0, 1, 1, 1);
    expect(slow).toBeCloseTo(fast);
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
      // Draw terminal caps also use arc+fill; only erases are destination-out.
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
  const arcRadii: number[] = [];
  const fillAlphas: number[] = [];
  const colorStops: string[] = [];
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
    },
    arc(x: number, y: number, r: number) {
      arcRadii.push(r);
      if (composite !== "destination-out") {
        caps.push({ ...map(x, y), r: r * transform[0] });
      }
    },
    fill() {
      fillCount++;
      fillAlphas.push(alpha);
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
    fillAlphas,
    colorStops,
    get strokeCount() {
      return strokeCount;
    },
    get fillCount() {
      return fillCount;
    },
    get radialGradients() {
      return radialGradients;
    },
  };
}

describe("inkDiscRadii / dwell growth", () => {
  it("starts smaller than tip radius and grows to tip without overshoot", () => {
    const tip = 10;
    const early = inkDiscRadii(tip, 0.55, 0);
    const mid = inkDiscRadii(tip, 0.55, 0.4);
    const full = inkDiscRadii(tip, 0.55, 1);
    expect(early.outerR).toBeCloseTo(tip * 0.04);
    expect(early.outerR).toBeLessThan(tip * 0.1);
    expect(mid.outerR).toBeGreaterThan(early.outerR);
    expect(mid.outerR).toBeLessThan(tip);
    expect(full.outerR).toBeCloseTo(tip);
    expect(full.outerR).toBeLessThanOrEqual(tip);
  });

  it("keeps a solid core with soft rim only outside innerR", () => {
    const { outerR, innerR } = inkDiscRadii(10, 1, 1);
    expect(innerR).toBeGreaterThan(0);
    expect(innerR).toBeLessThan(outerR);
    expect(outerR).toBeLessThanOrEqual(10);
  });

  it("uses a hard rim when blot blend is 0", () => {
    const { outerR, innerR } = inkDiscRadii(10, 0, 1);
    expect(innerR).toBeCloseTo(outerR);
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
    /*
     * A short dwell is a small pool, not an almost-finished one. This asserted
     * a 0.85 floor, which put a brief touch at 97.8% of full radius once
     * `inkDiscRadii` eased it -- there was no spread left to watch, which is
     * the "it thinks the first downpress was a full circle" complaint.
     */
    expect(one).toBe(1);
    expect(few).toBeGreaterThan(0);
    expect(few).toBeLessThan(0.5);
    expect(few).toBeLessThanOrEqual(1);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeGreaterThan(0.7);
  });

  /*
   * Moving does not finish the pool.
   *
   * `dwellBlotGrowT` used to open with `if (!isDiscPrimaryPath(...)) return 1`,
   * so the instant the samples spread past the nib -- the instant the pen
   * moved -- a pool that had crept out to a third of the nib was thrown away
   * and redrawn at full radius. Travelling samples have dwelled nowhere, so
   * they have grown nothing.
   */
  it("does not credit a travelling stroke with a finished pool", () => {
    expect(dwellBlotGrowT(points([0, 0], [40, 0], [80, 0]), 4, 0.5)).toBe(0);
  });
});

describe("Speed fade dries with travel, not pace", () => {
  const alphaAt = (consumed: number, fade: number, slowness = INK_SLOWNESS_NEUTRAL) =>
    inkStrokeAlpha(1, 0, false, consumed, slowness, 1, 1, fade);

  /*
   * Fade used to multiply opacity by pace -- slow dark, fast faint -- which is
   * a second reading of the signal Speed ink already owns, and not what a line
   * running out of ink does. It spends the reservoir against distance now.
   */
  it("keeps full ink at the head of a stroke however high the dial", () => {
    expect(alphaAt(0, 1)).toBeCloseTo(1);
    expect(alphaAt(0, 0.4)).toBeCloseTo(1);
  });

  it("dries further along the stroke, and further still at a higher dial", () => {
    expect(alphaAt(6, 1)).toBeLessThan(alphaAt(2, 1));
    expect(alphaAt(6, 1)).toBeLessThan(alphaAt(6, 0.4));
  });

  it("dries the same at the same travel whether the nib is slow or fast", () => {
    expect(alphaAt(5, 1, 1)).toBeCloseTo(alphaAt(5, 1, 0));
  });

  it("is full ink the whole way when fade is off", () => {
    for (const consumed of [0, 3, 12, 40]) {
      expect(alphaAt(consumed, 0)).toBeCloseTo(1);
    }
  });
});

describe("Body accent, bipolar and rest-only", () => {
  /*
   * The dial exists because Speed ink swells the nib wherever the hand is
   * slow, and pen-down and lift are the slowest samples in any stroke -- so
   * its loudest effect is round ends nobody asked for. Body scales that rest
   * weight, in both directions.
   */
  it("is rest weight: full at a stop, nothing at ordinary pace or a sprint", () => {
    expect(inkSpeedBodyShape(1)).toBeCloseTo(1);
    expect(inkSpeedBodyShape(INK_SLOWNESS_NEUTRAL)).toBeCloseTo(0);
    expect(inkSpeedBodyShape(0)).toBeCloseTo(0);
  });

  it("cancels the rest blob at -100 and fattens it at +100", () => {
    const plain = inkSpeedWidthGain(1, 1, 0);
    expect(inkSpeedWidthGain(1, 1, -1)).toBeLessThan(plain);
    expect(inkSpeedWidthGain(1, 1, 1)).toBeGreaterThan(plain);
    // -1 at a full stop exactly undoes Speed ink's own rest term: 1 + R(1-1).
    expect(inkSpeedWidthGain(1, 1, -1)).toBeCloseTo(1);
  });

  it("does nothing at all while Speed ink is off", () => {
    for (const body of [-1, -0.5, 0, 0.5, 1]) {
      expect(inkSpeedWidthGain(1, 0, body)).toBe(1);
    }
  });
});

describe("Speed ink is shape only", () => {
  function inkOp(extra: Partial<InkOp>): InkOp {
    const pts: ScenePoint[] = [];
    // A corner sharp enough to trip the join filter, then a dwell at the tail.
    for (let i = 0; i <= 20; i++) pts.push({ x: i * 5, y: 0, pressure: NO_PRESSURE });
    for (let i = 1; i <= 20; i++) pts.push({ x: 100, y: i * 5, pressure: NO_PRESSURE });
    for (let i = 0; i < 12; i++) {
      pts.push({ x: 100 + (i % 2) * 0.2, y: 100, pressure: NO_PRESSURE, slowness: 1 });
    }
    return {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedFade: 0,
      points: pts,
      ...extra,
    } as InkOp;
  }

  /*
   * The graphite belongs to Speed blot alone.
   *
   * The tip-cluster pool and the curvature join discs both ran unconditionally,
   * so a Speed-ink stroke with blot Off still broke its tail into a pool at
   * every lift and stamped a disc at every corner — a shape knob painting
   * pencil. Round ends on a Speed-ink stroke are rest-fatten plus the round
   * cap, which is a different thing and stays.
   */
  it("stamps no discs at joins or at lift when blot is off", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, inkOp({ speedInk: 1, speedBlotBlend: 0 }), 1);
    // The ribbon fills in chunks; a stamp is what builds a radial rim.
    expect(drawCtx.radialGradients).toBe(0);
  });

  it("still stamps them when blot is on", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, inkOp({ speedInk: 1, speedBlotBlend: 1 }), 1);
    expect(drawCtx.radialGradients).toBeGreaterThan(0);
  });
});

describe("fade falloff has no threshold to cross", () => {
  function fadedOp(points: ScenePoint[], speedFade = 1): InkOp {
    return {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.5,
      speedBlotBlend: 0,
      speedFade,
      points,
    };
  }
  const straight = () =>
    Array.from({ length: 300 }, (_, i) => ({
      x: i * 4,
      y: 40,
      pressure: NO_PRESSURE,
    })) as ScenePoint[];
  // Doubles back on itself: chord is short, travel is long.
  const coiled = () =>
    Array.from({ length: 300 }, (_, i) => {
      const t = (i / 300) * Math.PI * 6;
      return { x: 200 + Math.cos(t) * 60, y: 200 + Math.sin(t) * 60, pressure: NO_PRESSURE };
    }) as ScenePoint[];

  function alphaSpread(points: ScenePoint[]): number {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, fadedOp(points), 1);
    const used = drawCtx.fillAlphas.filter((a) => a > 0);
    return Math.max(...used) - Math.min(...used);
  }

  /*
   * A chord-projected gradient needed a "too coiled for a chord to mean
   * anything" test, and a boolean that flips as a stroke grows makes the whole
   * stroke swap between ramped and flat between frames -- which is a flash,
   * and the longer the stroke the likelier it is to cross. Alpha rides the
   * chunks now, so a coiled stroke ramps exactly like a straight one.
   */
  it("ramps a coiled stroke as it ramps a straight one", () => {
    expect(alphaSpread(straight())).toBeGreaterThan(0.05);
    expect(alphaSpread(coiled())).toBeGreaterThan(0.05);
  });

  it("is flat when fade is off, whatever the shape", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, fadedOp(coiled(), 0), 1);
    const used = drawCtx.fillAlphas.filter((a) => a > 0);
    expect(Math.max(...used) - Math.min(...used)).toBeCloseTo(0);
  });
});

describe("Speed blot stamp frequency", () => {
  function blotOp(blot: number, speedInk = 0.5): InkOp {
    const pts: ScenePoint[] = [];
    for (let i = 0; i <= 60; i++) {
      pts.push({ x: i * 6, y: 40 + Math.sin(i / 6) * 10, pressure: NO_PRESSURE });
    }
    return {
      kind: "draw",
      color: "#112233",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk,
      speedBlotBlend: blot,
      speedFade: 0,
      points: pts,
    };
  }
  /*
   * The ribbon fills in chunks, so a fill count no longer isolates stamps.
   * Each stamp builds its own radial rim, which the harness counts exactly.
   */
  function stamps(blot: number): number {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, blotOp(blot), 1);
    return drawCtx.radialGradients;
  }

  /*
   * The dial is the stamp spacing, and it has to be legible across its travel.
   * Blot used to reach the paint only as a dwell-speed tweak and a rim that no
   * call site ever drew, so 5% and 100% laid down identical pixels and the
   * control read as a switch.
   */
  it("stamps more often as the dial rises", () => {
    const faint = stamps(0.05);
    const mid = stamps(0.5);
    const full = stamps(1);
    expect(faint).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(faint);
    expect(full).toBeGreaterThan(mid);
  });

  /* Blot off is a plain ribbon: the one path fill, and nothing stamped on it. */
  /*
   * Live smoothing repaints the whole stroke every animation frame, so a stamp
   * count that rises with length is repaid each frame and the pen slows as the
   * word grows. Spacing widens to hold the count flat instead.
   */
  it("holds the stamp count flat as a stroke gets longer", () => {
    function longOp(segments: number): InkOp {
      const pts: ScenePoint[] = [];
      for (let i = 0; i <= segments; i++) {
        pts.push({ x: i * 6, y: 40 + Math.sin(i / 6) * 10, pressure: NO_PRESSURE });
      }
      return { ...blotOp(1), points: pts };
    }
    const shortRun = (() => {
      const c = inkDrawContext();
      applyInkOp(c.ctx, longOp(60), 1);
      return c.radialGradients;
    })();
    const longRun = (() => {
      const c = inkDrawContext();
      applyInkOp(c.ctx, longOp(1200), 1);
      return c.radialGradients;
    })();
    expect(longRun).toBeLessThanOrEqual(shortRun * 3);
  });

  it("stamps nothing at all when blot is off", () => {
    expect(stamps(0)).toBe(0);
  });

  /* Blot is standalone: it is a texture, not a mode of Speed ink. */
  it("stamps with Speed ink off", () => {
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, blotOp(1, 0), 1);
    expect(drawCtx.radialGradients).toBeGreaterThan(0);
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
    expect(drawCtx.arcRadii[0]).toBeCloseTo(4);
  });

  it("tip mode grows from a tiny hard core", () => {
    const drawCtx = inkDrawContext();
    paintInkDisc(drawCtx.ctx, { x: 10, y: 10 }, 8, 0.8, 1, 1, "#112233", false, 0);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(4 * 0.04);
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

  it("short-path / tip-down stroke paints a full tip, not a 4% core", () => {
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
    const hairline = inkDiscRadii(tipR, 1, 0).outerR;
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThanOrEqual(1);
    expect(drawCtx.arcRadii[0]).toBeCloseTo(tipR);
    expect(drawCtx.arcRadii[0]).toBeGreaterThan(hairline * 4);
    expect(drawCtx.fillAlphas[0]).toBe(1);
  });

  /*
   * Speed ink is shape only; it may not spend the alpha budget.
   *
   * `resolveSpeedFade` returned 1 whenever Speed ink was on and the stroke
   * carried no fade of its own, so every such stroke was multiplied by
   * `INK_SPEED_ALPHA_BASE` -- switching Speed ink on quietly turned the pen
   * grey instead of leaving it the colour the wheel shows. Strokes written
   * before the field existed now render at full colour rather than washed;
   * that is the intended repair, not a side effect.
   */
  it("leaves a speed-ink stroke that never stamped fade at full colour", () => {
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
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.fillAlphas[0]).toBeCloseTo(1);
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
    // Runs stroke; a ribbon fills. The ribbon is now one path, so the tell is
    // many segment subpaths inside a single rasterisation, not many fills.
    expect(drawCtx.strokeCount).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
    expect(drawCtx.strokes.length).toBeGreaterThan(6);
  });
});

describe("fillInkRibbon seams and winding", () => {
  /** Rebuild each triangle subpath from the recorded moveTo/lineTo pen path. */
  function trianglesFrom(drawCtx: ReturnType<typeof inkDrawContext>) {
    const out: Array<Array<{ x: number; y: number }>> = [];
    // A triangle is a moveTo plus two lineTo; only lineTo is recorded.
    for (let i = 0; i + 1 < drawCtx.strokes.length; i += 2) {
      out.push([
        drawCtx.strokes[i].from,
        drawCtx.strokes[i].to,
        drawCtx.strokes[i + 1].to,
      ]);
    }
    return out;
  }

  function twiceArea(poly: Array<{ x: number; y: number }>): number {
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      sum += (b.x - a.x) * (b.y + a.y);
    }
    return sum;
  }

  /*
   * One rasterisation, two triangles per segment.
   *
   * A `fill()` per segment antialiases the edge each pair of them shares
   * twice, which composites to about 0.75 coverage and rules the stroke with a
   * lighter hairline every densified point. Measured on a straight ribbon: 66
   * of 375 centre-row pixels short of full ink that way, 0 as one path. That
   * cross-hatching is what made a Speed-ink ribbon read as graphite.
   */
  it("fills the whole ribbon in one rasterisation", () => {
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
    expect(drawCtx.fillCount).toBe(1);
    expect(trianglesFrom(drawCtx)).toHaveLength(4);
  });

  it("winds every subpath the same way, so nothing cancels where a stroke doubles back", () => {
    const drawCtx = inkDrawContext();
    /*
     * Bow-tie sides: the raw vertex order flips orientation across these
     * segments, and one nonzero fill would subtract the flipped subpath and
     * punch a hole. Quads could not be normalised here — this pair has a
     * signed area of exactly zero, so it has no orientation to correct.
     */
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
    const tris = trianglesFrom(drawCtx);
    expect(tris).toHaveLength(4);
    /*
     * Negative, matching `ctx.arc(...)` with the default sweep. Join discs and
     * caps are subpaths of this same path, so a ribbon triangle wound the
     * other way would cancel against a disc under nonzero fill and punch a
     * hole where the stroke turns.
     */
    const signs = tris.map((t) => Math.sign(twiceArea(t)));
    expect(signs.every((sign) => sign < 0)).toBe(true);
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

  /*
   * Blot Off is flat ink: one path, no soft edges anywhere. Blot On is the
   * opposite by design -- each stamp fades at its rim so neighbouring stamps
   * cross-fade into one another and into the ribbon, which is what makes the
   * build-up read as grain instead of a row of beads threaded on the line.
   */
  it("paints no soft radial edges when blot is off", () => {
    const pts = points([0, 0], [15, 2], [30, -1], [45, 3], [60, 0], [75, 2], [90, 0]);
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
      points: pts,
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.radialGradients).toBe(0);
    expect(drawCtx.fillCount).toBeGreaterThan(0);
  });

  it("gives every blot stamp a soft rim so they blend rather than bead", () => {
    const pts = points([0, 0], [15, 2], [30, -1], [45, 3], [60, 0], [75, 2], [90, 0]);
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
      points: pts,
    };
    const drawCtx = inkDrawContext();
    applyInkOp(drawCtx.ctx, op, 1);
    expect(drawCtx.radialGradients).toBeGreaterThan(0);
    // Solid at the core, gone at the rim.
    expect(drawCtx.colorStops).toContain("rgba(17, 34, 51, 1)");
    expect(drawCtx.colorStops).toContain("rgba(17, 34, 51, 0)");
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
    const { ctx, caps } = inkDrawContext();
    applyInkOp(ctx, draw([0, 0], [50, 0]), 1, { capHead: false, capEnd: true });
    expect(caps).toHaveLength(1);
    applyInkOp(ctx, draw([0, 0], [50, 0]), 1, { capHead: true, capEnd: true });
    expect(caps).toHaveLength(3);
    applyInkOp(ctx, draw([0, 0], [50, 0]), 1, { capHead: false, capEnd: false });
    expect(caps).toHaveLength(3);
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

  it("paintLiveOp passes capHead false for long open strokes", () => {
    const viewport = {
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
      offsetLeft: 0,
      offsetTop: 0,
      width: 100,
      height: 100,
    };
    const { ctx, caps } = inkDrawContext();
    paintLiveOp(ctx, draw([0, 0], [50, 0], [100, 0]), viewport, 1, null);
    expect(caps).toHaveLength(0);
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
    const { ctx, caps, fillCount } = inkDrawContext();
    paintLiveOp(ctx, draw([0, 0], [5, 0]), viewport, 1, null);
    expect(caps.length + fillCount).toBeGreaterThan(0);
  });
});
