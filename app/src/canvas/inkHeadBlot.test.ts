import { describe, it, expect, beforeAll } from "vitest";
import { applyInkOp, type ScenePoint } from "./rasterInk";

const logs: string[][] = [];
beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    width: number; height: number; log: string[] = [];
    constructor(w: number, h: number) { this.width = w; this.height = h; logs.push(this.log); }
    getContext() {
      const log = this.log;
      const t: Record<string, unknown> = {
        createLinearGradient: () => ({ addColorStop: () => {} }),
        canvas: { width: this.width, height: this.height },
      };
      return new Proxy(t, {
        get(o, p: string) {
          if (p in o) return o[p];
          return (...a: unknown[]) => log.push(`${p}(${a.map((v) => typeof v === "number" ? v.toFixed(4) : String(v)).join(",")})`);
        },
        set(o, p: string, v) { o[p] = v; return true; },
      });
    }
  };
});

const P = (x: number, y: number): ScenePoint => ({ x, y, pressure: 0.6, slowness: 1.9 });

/** Largest disc drawn within a nib of the stroke's head. */
function headDisc(grow: number) {
  // The ribbon scratch is a module-global that is reused, so a fresh canvas is
  // not constructed per call. Read only what each existing log gained.
  const mark = logs.map((l) => l.length);
  const pts: ScenePoint[] = [];
  for (let i = 0; i < 40; i++) pts.push(P(Math.sin(i) * 0.08, Math.cos(i) * 0.08));
  for (let i = 1; i <= 80; i++) pts.push(P(i * 3, i * 0.4));
  const op = { kind: "draw" as const, color: "#c41e3a", baseWidth: 10, maxFullness: 1,
    pressureClip: 1, pressureSensitive: false, speedInk: 0.6, speedBlotBlend: 0.9,
    blotTipGrow: 0, points: pts,
    ...(grow > 1e-6 ? { blotHalts: [{ x: 0, y: 0, grow, pressure: 0.6 }] } : {}) };
  const ctx = new Proxy({ drawImage: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }) } as Record<string, unknown>,
    { get(o, p: string) { return p in o ? o[p] : () => {}; }, set() { return true; } });
  applyInkOp(ctx as unknown as CanvasRenderingContext2D, op, 1);
  let best = 0;
  for (let li = 0; li < logs.length; li++) {
    const log = logs[li];
    for (const line of log.slice(mark[li] ?? 0)) {
      const m = /^arc\((-?[\d.]+),(-?[\d.]+),([\d.]+)/.exec(line);
      if (!m) continue;
      // Only discs sitting at the head, not the tip or joins along the trail.
      if (Math.hypot(Number(m[1]), Number(m[2])) > 20) continue;
      best = Math.max(best, Number(m[3]));
    }
  }
  return best;
}

describe("the head blot has no threshold to flicker across", () => {
  it("grows continuously with the hold, from nothing", () => {
    const steps = 40;
    const seen: number[] = [];
    for (let i = 0; i <= steps; i++) seen.push(headDisc(i / steps));
    const base = seen[0];
    let biggestJump = 0;
    for (let i = 1; i < seen.length; i++) {
      biggestJump = Math.max(biggestJump, Math.abs(seen[i] - seen[i - 1]));
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-6);   // monotone
    }
    const span = seen[seen.length - 1] - base;
    console.log(`\nhead disc: ${base.toFixed(2)} -> ${seen[seen.length - 1].toFixed(2)} over the sweep; biggest single step ${biggestJump.toFixed(3)} (${((biggestJump / Math.max(span, 1e-9)) * 100).toFixed(1)}% of the range)\n`);
    expect(span).toBeGreaterThan(1);
    // No step may carry a large share of the range: that is what a switch looks like.
    expect(biggestJump).toBeLessThan(span * 0.15);
  });
});
