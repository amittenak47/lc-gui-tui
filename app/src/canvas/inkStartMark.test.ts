import { describe, it, expect, beforeAll } from "vitest";
import { applyInkOp, inkLineWidth, type ScenePoint } from "./rasterInk";

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
          return (...a: unknown[]) =>
            log.push(`${p}(${a.map((v) => (typeof v === "number" ? v.toFixed(4) : String(v))).join(",")})`);
        },
        set(o, p: string, v) { o[p] = v; return true; },
      });
    }
  };
});

const nib = inkLineWidth(10, 0, false);

/**
 * Horizontal extent of everything drawn for a stroke of this length.
 *
 * The short-stroke branch paints straight onto the destination and the ribbon
 * paints into the scratch, so both have to be watched or half the mark is
 * invisible to the measurement.
 */
function drawnSpan(len: number) {
  const mark = logs.map((l) => l.length);
  const n = Math.max(2, Math.round(len / 0.35));
  const pts: ScenePoint[] = [];
  for (let i = 0; i < n; i++)
    pts.push({ x: (i / (n - 1)) * len, y: 0, pressure: 0.6, slowness: 1.9 });
  const op = { kind: "draw" as const, color: "#c41e3a", baseWidth: 10, maxFullness: 1,
    pressureClip: 1, pressureSensitive: false, speedInk: 0.6, speedBlotBlend: 0.9,
    blotTipGrow: 0, points: pts };
  const main: string[] = [];
  logs.push(main);
  const ctx = new Proxy(
    { drawImage: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }) } as Record<string, unknown>,
    { get(o, p: string) {
        if (p in o) return o[p];
        return (...a: unknown[]) =>
          main.push(`${p}(${a.map((v) => (typeof v === "number" ? v.toFixed(4) : String(v))).join(",")})`);
      },
      set() { return true; } },
  );
  applyInkOp(ctx as unknown as CanvasRenderingContext2D, op, 1);
  let minX = Infinity, maxX = -Infinity;
  for (let li = 0; li < logs.length; li++) {
    for (const line of logs[li].slice(mark[li] ?? 0)) {
      let m = /^arc\((-?[\d.]+),(-?[\d.]+),([\d.]+)/.exec(line);
      if (m) {
        minX = Math.min(minX, Number(m[1]) - Number(m[3]));
        maxX = Math.max(maxX, Number(m[1]) + Number(m[3]));
        continue;
      }
      m = /^(?:moveTo|lineTo)\((-?[\d.]+),(-?[\d.]+)\)/.exec(line);
      if (m) { minX = Math.min(minX, Number(m[1])); maxX = Math.max(maxX, Number(m[1])); }
    }
  }
  return maxX - minX;
}

describe("the start mark does not pop when a stroke outgrows the contact disc", () => {
  it("never retracts as the stroke lengthens", () => {
    let prev: number | null = null;
    let worstShrink = 0;
    let worstStep = 0;
    for (let len = 2; len <= 26; len += 0.5) {
      const span = drawnSpan(len);
      expect(Number.isFinite(span)).toBe(true);
      if (prev !== null) {
        worstShrink = Math.max(worstShrink, prev - span);
        worstStep = Math.max(worstStep, Math.abs(span - prev));
      }
      prev = span;
    }
    // A mark that shrinks while the stroke grows is the flash.
    expect(worstShrink).toBeLessThanOrEqual(0.01);
    // And no single step may jump by a large share of a nib.
    expect(worstStep).toBeLessThan(nib * 0.2);
  });
});
