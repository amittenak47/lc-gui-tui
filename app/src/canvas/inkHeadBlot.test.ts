import { describe, it, expect } from "vitest";
import { applyInkOp, inkCapRoundness, type ScenePoint } from "./rasterInk";

const P = (x: number, y: number): ScenePoint => ({ x, y, pressure: 0.6, slowness: 1.9 });

function loggingCtx() {
  const arcs: Array<{ x: number; y: number; r: number }> = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    setTransform() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    save() {},
    restore() {},
    clip() {},
    rect() {},
    drawImage() {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    arc(x: number, y: number, r: number) {
      arcs.push({ x, y, r });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs };
}

/** Largest disc drawn within a nib of the stroke's head. */
function headDisc(grow: number) {
  const pts: ScenePoint[] = [];
  for (let i = 0; i < 40; i++) pts.push(P(Math.sin(i) * 0.08, Math.cos(i) * 0.08));
  for (let i = 1; i <= 80; i++) pts.push(P(i * 3, i * 0.4));
  const op = {
    kind: "draw" as const,
    color: "#c41e3a",
    baseWidth: 10,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    speedInk: 0.6,
    speedBlotBlend: 0.9,
    blotTipGrow: 0,
    points: pts,
    ...(grow > 1e-6 ? { blotHalts: [{ x: 0, y: 0, grow, pressure: 0.6 }] } : {}),
  };
  const { ctx, arcs } = loggingCtx();
  applyInkOp(ctx, op, 1);
  let best = 0;
  for (const a of arcs) {
    if (Math.hypot(a.x, a.y) > 20) continue;
    best = Math.max(best, a.r);
  }
  return best;
}

describe("the head blot has no threshold to flicker across", () => {
  it("grows continuously with the hold, from nothing", () => {
    const steps = 40;
    const seen: number[] = [];
    for (let i = 0; i <= steps; i++) seen.push(headDisc(i / steps));
    const base = seen[0]!;
    let biggestJump = 0;
    for (let i = 1; i < seen.length; i++) {
      biggestJump = Math.max(biggestJump, Math.abs(seen[i]! - seen[i - 1]!));
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]! - 1e-6);
    }
    const span = seen[seen.length - 1]! - base;
    expect(span).toBeGreaterThan(1);
    expect(biggestJump).toBeLessThan(span * 0.15);
  });
});

function squareHashOrigin(): { x: number; y: number } {
  for (let i = 0; i < 80; i++) {
    const o = { x: i * 19, y: i * 5 };
    if (inkCapRoundness(o, 1) < 0.35) return o;
  }
  throw new Error("no square-hash origin");
}

function headArcRadii(op: Parameters<typeof applyInkOp>[1], at: { x: number; y: number }) {
  const { ctx, arcs } = loggingCtx();
  applyInkOp(ctx, op, 1);
  return arcs
    .filter((a) => Math.hypot(a.x - at.x, a.y - at.y) <= 20)
    .map((a) => a.r);
}

describe("the pooled head leaves the contact disc as one round cap", () => {
  it("does not plot a second disc of a different radius on a square-hash origin", () => {
    const origin = squareHashOrigin();
    const pts: ScenePoint[] = [
      { x: origin.x, y: origin.y, pressure: 0.6, slowness: 1.9 },
      { x: origin.x + 48, y: origin.y, pressure: 0.6, slowness: 0.4 },
    ];
    const base = {
      kind: "draw" as const,
      color: "#c41e3a",
      baseWidth: 10,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedBlotBlend: 0.9,
      blotTipGrow: 0,
      blotHalts: [{ x: origin.x, y: origin.y, grow: 0.55, pressure: 0.6 }],
      points: pts,
    };
    for (const speedInk of [0, 0.6]) {
      const radii = headArcRadii({ ...base, speedInk }, origin);
      expect(radii.length).toBeGreaterThan(0);
      const min = Math.min(...radii);
      const max = Math.max(...radii);
      expect(max - min).toBeLessThan(0.05);
    }
  });
});
