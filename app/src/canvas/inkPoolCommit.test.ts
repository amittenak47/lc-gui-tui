import { describe, it, expect } from "vitest";
import { applyInkPoolingAtEnds, inkStrokePointStyles, liveInkBlotGrow,
  inkLineWidth, INK_BLOT_SIZE_RANGE, type ScenePoint } from "./rasterInk";
import { smoothInkPoints } from "./inkSmoothing";

const P = (x: number, y: number): ScenePoint => ({ x, y, pressure: 0.6, slowness: 1.9 });
const BLEND = 0.9;
const base = { kind: "draw" as const, color: "#c41e3a", baseWidth: 10, maxFullness: 1,
  pressureClip: 1, pressureSensitive: false, speedInk: 0.6, speedBlotBlend: BLEND };
const nib = inkLineWidth(10, 0, false);

function headGrow(op: Parameters<typeof applyInkPoolingAtEnds>[1], pts: ScenePoint[]) {
  const raw = inkStrokePointStyles(op, 0)[0].lineWidth;
  const pooled = applyInkPoolingAtEnds(inkStrokePointStyles(op, 0), op, pts, 0)[0].lineWidth;
  return (pooled / raw - 1) / (INK_BLOT_SIZE_RANGE * BLEND);
}

describe("lift-mode: hold at the head, then draw away", () => {
  // ticks = how much blotTipGrow accrued. A short hold accrues little; the
  // pool the writer sees comes from the raw dwell cluster instead.
  for (const ticks of [0, 0.1, 0.5]) {
    it(`survives commit-time smoothing (blotTipGrow=${ticks})`, () => {
      const rows: string[] = [];
      for (const strength of [0.3, 0.6, 1.0]) {
        const dwell: ScenePoint[] = [];
        for (let i = 0; i < 40; i++) dwell.push(P(Math.sin(i) * 0.08, Math.cos(i) * 0.08));
        const travel: ScenePoint[] = [];
        for (let i = 1; i <= 80; i++) travel.push(P(i * 3, i * 0.4));

        // DURING THE DRAG: points are raw. This is what the writer sees, and
        // what noteInkTravel sees when it stamps the halt.
        const atTravel = { ...base, blotTipGrow: ticks, points: dwell };
        const live = headGrow(atTravel, dwell);
        const stampNew = liveInkBlotGrow(atTravel);   // max of both terms
        const stampOld = ticks;                       // tick term only

        // AT PEN-UP: lift mode smooths the finished stroke.
        const committed = smoothInkPoints([...dwell, ...travel], strength, nib);
        const halt = (g: number) => g > 1e-3
          ? { blotHalts: [{ x: committed[0].x, y: committed[0].y, grow: g, pressure: 0.6 }] }
          : {};
        const now = headGrow({ ...base, blotTipGrow: 0, points: committed, ...halt(stampNew) }, committed);
        const was = headGrow({ ...base, blotTipGrow: 0, points: committed, ...halt(stampOld) }, committed);

        rows.push(`smooth=${strength.toFixed(1)}  live=${live.toFixed(3)}  committed now=${now.toFixed(3)}  was=${was.toFixed(3)}`);
        // What was on screen is what commits.
        expect(now).toBeCloseTo(live, 3);
      }
      console.log("\n" + rows.join("\n"));
    });
  }
});

const growAt = (op: Parameters<typeof applyInkPoolingAtEnds>[1], pts: ScenePoint[], i: number) =>
  applyInkPoolingAtEnds(inkStrokePointStyles(op, 0), op, pts, 0)[i].blotGrow ?? 0;

describe("terminals know whether they are pooled", () => {
  const travel: ScenePoint[] = [];
  for (let i = 1; i <= 80; i++) travel.push(P(i * 3, i * 0.4));

  it("records growth at a held head", () => {
    const dwell: ScenePoint[] = [];
    for (let i = 0; i < 40; i++) dwell.push(P(Math.sin(i) * 0.08, Math.cos(i) * 0.08));
    const pts = [...dwell, ...travel];
    const op = { ...base, blotTipGrow: 0, points: pts,
      blotHalts: [{ x: 0, y: 0, grow: 0.9, pressure: 0.6 }] };
    expect(growAt(op, pts, 0)).toBeGreaterThan(0.12);
  });

  it("records none on a head that was never held", () => {
    const pts = [P(0, 0), ...travel];
    const op = { ...base, blotTipGrow: 0, points: pts };
    expect(growAt(op, pts, 0)).toBeLessThanOrEqual(0.12);
  });

  it("leaves width and growth consistent", () => {
    const dwell: ScenePoint[] = [];
    for (let i = 0; i < 40; i++) dwell.push(P(Math.sin(i) * 0.08, Math.cos(i) * 0.08));
    const pts = [...dwell, ...travel];
    const op = { ...base, blotTipGrow: 0, points: pts,
      blotHalts: [{ x: 0, y: 0, grow: 0.9, pressure: 0.6 }] };
    const raw = inkStrokePointStyles(op, 0);
    const pooled = applyInkPoolingAtEnds(raw, op, pts, 0);
    // Growth recorded must be the growth actually applied to the width.
    const g = pooled[0].blotGrow ?? 0;
    expect(pooled[0].lineWidth / raw[0].lineWidth).toBeCloseTo(1 + 0.55 * 0.9 * g, 6);
  });

  it("a halt at the origin still grows a one-point contact disc", () => {
    const op = {
      ...base,
      blotTipGrow: 0,
      points: [P(0, 0)],
      blotHalts: [{ x: 0, y: 0, grow: 0.7, pressure: 0.6 }],
    };
    expect(liveInkBlotGrow(op)).toBeCloseTo(0.7);
  });
});
