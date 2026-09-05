import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { applyInkOp, beginInkOpBatch, endInkOpBatch, liveRibbonStats, releaseLiveRibbonBuffers, setLiveRibbonCoarseDensify, setLiveRibbonSuffix, settledRibbonStats, type ScenePoint } from "./rasterInk";

beforeAll(() => {
  // The ribbon scratch asks for an OffscreenCanvas; hand it a real one.
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(w: number, h: number) { return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object; }
  };
});

const W = 900, H = 500;
function pixels(op: Parameters<typeof applyInkOp>[1], whole: boolean) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#e8e4d4"; ctx.fillRect(0, 0, W, H);
  // Inside a batch window the settled prefix is never offered, so this is the
  // whole-ribbon draw the cache has to match.
  if (whole) beginInkOpBatch();
  try { applyInkOp(ctx, op, 1); } finally { if (whole) endInkOpBatch(); }
  return c.getContext("2d").getImageData(0, 0, W, H).data;
}

describe("settled prefix", () => {
  afterEach(() => {
    setLiveRibbonSuffix(true);
    setLiveRibbonCoarseDensify(true);
    releaseLiveRibbonBuffers();
  });

  /*
   * A live paint redraws the whole ribbon every frame. The settled prefix
   * bakes the quads behind the pen and draws only the tail, and the only
   * acceptable outcome is that nobody can tell: every frame of a growing
   * stroke must be byte-identical to drawing it whole.
   *
   * Suffix tessellation freezes last frame's mesh, so this gate turns it off
   * and checks the bake alone.
   */
  it("renders a growing signature byte-identical to a whole draw, and actually engages", () => {
    setLiveRibbonSuffix(false);
    setLiveRibbonCoarseDensify(false);
    const path: ScenePoint[] = [];
    for (let i = 0; i < 520; i++) {
      const t = i / 60;
      path.push({ x: 40 + i * 1.4 + Math.sin(t * 3) * 30, y: 250 + Math.sin(t) * 90 + Math.sin(t * 7) * 25,
        pressure: 0.5 + 0.3 * Math.sin(i / 9), slowness: 1 + Math.sin(i / 11) });
    }
    const live: ScenePoint[] = [];
    const halts: { x: number; y: number; grow: number; pressure: number }[] = [];
    const op = { kind: "draw" as const, color: "#c41e3a", baseWidth: 5, maxFullness: 1, pressureClip: 1,
      pressureSensitive: true, speedInk: 0.6, speedBlotBlend: 0.9, speedFade: 0.4, blotTipGrow: 0, points: live, blotHalts: halts };
    Object.assign(settledRibbonStats, { hits: 0, extends: 0, rebuilds: 0, bails: 0, copies: 0 });
    Object.assign(liveRibbonStats, { suffixHits: 0, suffixMisses: 0, suffixRewinds: 0 });
    let checked = 0;
    for (let i = 0; i < path.length; i++) {
      live.push(path[i]);
      if (i % 90 === 45) halts.push({ x: path[i].x, y: path[i].y, grow: 0.7, pressure: 0.6 });
      op.blotTipGrow = i % 90 > 80 ? 0.3 : 0;
      const a = pixels(op, false);
      if (i % 4 === 3 || i === path.length - 1) {
        const b = pixels(op, true);
        let bad = 0;
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) bad++;
        expect(bad).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // Exactness alone proves nothing if the cache never engaged.
    const s = settledRibbonStats;
    expect(s.extends + s.hits).toBeGreaterThan(200);
    expect(s.rebuilds).toBeLessThan(s.extends);
  });

  it("rebuilds the baked prefix when a blotHalt lands in it", () => {
    setLiveRibbonSuffix(false);
    setLiveRibbonCoarseDensify(false);
    const path: ScenePoint[] = [];
    for (let i = 0; i < 360; i++) {
      path.push({
        x: 40 + i * 1.4,
        y: 250,
        pressure: 0.5,
        slowness: 1,
      });
    }
    const live: ScenePoint[] = [];
    const halts: { x: number; y: number; grow: number; pressure: number }[] = [];
    const op = {
      kind: "draw" as const,
      color: "#c41e3a",
      baseWidth: 5,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: true,
      speedInk: 0.6,
      speedBlotBlend: 0.9,
      speedFade: 0.4,
      blotTipGrow: 0,
      points: live,
      blotHalts: halts,
    };
    Object.assign(settledRibbonStats, { hits: 0, extends: 0, rebuilds: 0, bails: 0, copies: 0, firstBad: -1 });
    for (let i = 0; i < 300; i++) {
      live.push(path[i]!);
      pixels(op, false);
    }
    expect(settledRibbonStats.extends + settledRibbonStats.hits).toBeGreaterThan(0);
    const rebuildsBefore = settledRibbonStats.rebuilds;
    halts.push({ x: path[40]!.x, y: path[40]!.y, grow: 1, pressure: 0.6 });
    pixels(op, false);
    expect(settledRibbonStats.rebuilds).toBeGreaterThan(rebuildsBefore);
    const a = pixels(op, false);
    const b = pixels(op, true);
    let bad = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) bad++;
    expect(bad).toBe(0);
  });

  it("copies the baked prefix when the stroke grows up, without restyling it", () => {
    setLiveRibbonSuffix(false);
    setLiveRibbonCoarseDensify(false);
    releaseLiveRibbonBuffers();
    const live: ScenePoint[] = [];
    const op = {
      kind: "draw" as const,
      color: "#c41e3a",
      baseWidth: 5,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: true,
      speedInk: 0.6,
      speedBlotBlend: 0.9,
      speedFade: 0.4,
      blotTipGrow: 0,
      points: live,
    };
    Object.assign(settledRibbonStats, { hits: 0, extends: 0, rebuilds: 0, bails: 0, copies: 0 });
    // Rightward until the bake engages, then up — the origin must move.
    for (let i = 0; i < 300; i++) {
      live.push({ x: 40 + i * 1.4, y: 400, pressure: 0.5, slowness: 1 });
      pixels(op, false);
    }
    expect(settledRibbonStats.extends + settledRibbonStats.hits).toBeGreaterThan(0);
    const rebuildsBefore = settledRibbonStats.rebuilds;
    for (let i = 0; i < 80; i++) {
      live.push({ x: 40 + 299 * 1.4, y: 400 - i * 1.6, pressure: 0.5, slowness: 1 });
      const a = pixels(op, false);
      const b = pixels(op, true);
      let bad = 0;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) bad++;
      expect(bad).toBe(0);
    }
    expect(settledRibbonStats.copies).toBeGreaterThan(0);
    expect(settledRibbonStats.rebuilds).toBe(rebuildsBefore);
  });

  it("tessellates only the live suffix on a long growing stroke", () => {
    releaseLiveRibbonBuffers();
    const live: ScenePoint[] = [];
    const op = {
      kind: "draw" as const,
      color: "#111111",
      baseWidth: 5,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0.9,
      speedFade: 1,
      blotTipGrow: 0,
      points: live,
    };
    Object.assign(liveRibbonStats, { suffixHits: 0, suffixMisses: 0, suffixRewinds: 0 });
    Object.assign(settledRibbonStats, { hits: 0, extends: 0, rebuilds: 0, bails: 0, copies: 0 });
    for (let i = 0; i < 420; i++) {
      live.push({ x: 40 + i * 1.2, y: 250, pressure: 0.5, slowness: 1 });
      pixels(op, false);
    }
    expect(liveRibbonStats.suffixHits).toBeGreaterThan(20);
    expect(settledRibbonStats.extends + settledRibbonStats.hits).toBeGreaterThan(0);
  });
});
