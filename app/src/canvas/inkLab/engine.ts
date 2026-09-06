/**
 * Ink lab engine. Host-owned overlay: attach / down / move / up / paint / clear.
 * Camera later is zoom and scrollX/Y numbers, not a scene API.
 */

import { inkSlowness } from "../rasterInk";

import { createEkf, type EkfFilter } from "./ekf";
import { createFallbackPainter, fillMiterStroke } from "./fallback";
import {
  emptyAabb,
  expandAabb,
  INSTANCE_FLOATS,
  writeInstance,
  type SpineDot,
  type StrokeAabb,
} from "./instance";
import { tryCreateSdfRenderer, type SdfRenderer } from "./sdf";

export type InkLabBackend = "webgl2" | "canvas2d";
export type InkLabBake = "catmull" | "clothoid";

export type InkLabSample = {
  x: number;
  y: number;
  p: number;
  t: number;
};

export type InkLabPaintStats = {
  frameMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
};

export type InkLabEngine = {
  attach(canvas: HTMLCanvasElement): InkLabBackend;
  down(s: InkLabSample): void;
  move(batch: InkLabSample[]): void;
  up(s: InkLabSample): { bakeMs: number; bake: InkLabBake };
  paint(): InkLabPaintStats;
  clear(): void;
  destroy(): void;
};

export type InkLabEngineOpts = {
  clothoid?: boolean;
  capillary?: boolean;
};

export const DISTANCE_GATE_CSS = 2.5;
const INK: [number, number, number] = [26, 26, 26];
const BASE_R_CSS = 7;
const TIP_GROW = 1.7;

function peerFactory(
  host: HTMLCanvasElement,
): (w: number, h: number) => HTMLCanvasElement | null {
  return (w: number, h: number) => {
    const width = Math.max(1, w);
    const height = Math.max(1, h);
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      return c;
    }
    const g = globalThis as {
      OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
    };
    if (typeof g.OffscreenCanvas === "function") {
      return new g.OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
    }
    const Ctor = host.constructor as unknown as {
      new (w: number, h: number): HTMLCanvasElement;
    };
    if (typeof Ctor === "function") {
      try {
        const c = new Ctor(width, height);
        if (c && typeof c.getContext === "function") return c;
      } catch {
        return null;
      }
    }
    return null;
  };
}

function dprOf(canvas: HTMLCanvasElement): number {
  const css = Math.max(1, canvas.clientWidth || canvas.width);
  return Math.max(1, canvas.width / css);
}

function nibRadius(vx: number, vy: number, dpr: number, pressure: number): number {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / dpr;
  const slow = inkSlowness(cssPxPerMs);
  const p = Math.max(0.15, Math.min(1, pressure));
  return Math.max(1.15 * dpr, BASE_R_CSS * dpr * (0.5 + 0.95 * slow) * (0.7 + 0.3 * p));
}

export function createInkLabEngine(opts: InkLabEngineOpts = {}): InkLabEngine {
  const clothoidWanted = opts.clothoid === true;
  void clothoidWanted;
  let host: HTMLCanvasElement | null = null;
  let backend: InkLabBackend = "canvas2d";
  let sdf: SdfRenderer | null = null;
  let fallback = null as ReturnType<typeof createFallbackPainter>;
  let snap: HTMLCanvasElement | null = null;
  let peer: ReturnType<typeof peerFactory> | null = null;
  let ekf: EkfFilter = createEkf();
  let spine: SpineDot[] = [];
  let inst = new Float32Array(32 * INSTANCE_FLOATS);
  let instCap = 32;
  let segs = 0;
  let aabb: StrokeAabb = emptyAabb();
  let drawing = false;
  let holding = false;
  let tip: SpineDot | null = null;
  let lastEkfMs = 0;

  const ensureInst = (n: number) => {
    if (n <= instCap) return;
    let cap = instCap;
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap * INSTANCE_FLOATS);
    next.set(inst);
    inst = next;
    instCap = cap;
  };

  const resetLive = () => {
    spine = [];
    segs = 0;
    aabb = emptyAabb();
    drawing = false;
    holding = false;
    tip = null;
    ekf = createEkf();
    sdf?.clear();
    fallback?.clearLive();
  };

  const syncSize = () => {
    if (!host || !peer) return;
    const w = Math.max(1, host.width);
    const h = Math.max(1, host.height);
    if (!snap) snap = peer(w, h);
    if (snap && (snap.width !== w || snap.height !== h)) {
      const prev = peer(snap.width, snap.height);
      if (prev && snap.width > 0) {
        prev.width = snap.width;
        prev.height = snap.height;
        prev.getContext("2d")?.drawImage(snap, 0, 0);
      }
      snap.width = w;
      snap.height = h;
      if (prev && prev.width > 0) snap.getContext("2d")?.drawImage(prev, 0, 0);
    }
    sdf?.resize(w, h);
    fallback?.resize(w, h);
  };

  const appendSpine = (dot: SpineDot) => {
    const prev = spine[spine.length - 1];
    spine.push(dot);
    expandAabb(aabb, dot);
    tip = dot;
    holding = false;
    if (!prev) return;
    ensureInst(segs + 1);
    writeInstance(inst, segs, prev, dot, INK, INK);
    segs += 1;
    fallback?.appendHop(prev, dot, INK);
  };

  const ingest = (s: InkLabSample) => {
    const t0 = performance.now();
    const dpr = host ? dprOf(host) : 1;
    const gate = DISTANCE_GATE_CSS * dpr;
    if (spine.length === 0) {
      ekf.reset(s.x, s.y, s.t);
      const first: SpineDot = {
        x: s.x,
        y: s.y,
        r: nibRadius(0, 0, dpr, s.p),
      };
      spine.push(first);
      expandAabb(aabb, first);
      tip = first;
      fallback?.beginStroke();
      lastEkfMs = performance.now() - t0;
      return;
    }
    const f = ekf.step(s.x, s.y, s.t);
    const r = nibRadius(f.vx, f.vy, dpr, s.p);
    const dot: SpineDot = { x: f.x, y: f.y, r };
    lastEkfMs = performance.now() - t0;
    const last = spine[spine.length - 1]!;
    const dist = Math.hypot(dot.x - last.x, dot.y - last.y);
    if (dist < gate) {
      holding = true;
      const grown = Math.min(last.r * TIP_GROW, last.r + (TIP_GROW - 1) * last.r * 0.05);
      tip = { x: last.x, y: last.y, r: Math.max(dot.r, grown) };
      return;
    }
    appendSpine(dot);
  };

  const blitLiveToSnap = () => {
    if (!snap) return;
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    if (sdf) {
      ensureInst(segs + 1);
      let n = segs;
      if (tip) {
        writeInstance(inst, n, tip, tip, INK, INK);
        n += 1;
      }
      sdf.upload(inst, n);
      sdf.draw(aabb);
      sctx.drawImage(sdf.canvas, 0, 0);
    } else {
      fillMiterStroke(sctx, spine, tip, INK);
    }
  };

  const composite = () => {
    if (!host) return;
    const ctx = host.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, host.width, host.height);
    if (snap) ctx.drawImage(snap, 0, 0);
    if (!drawing) return;
    if (sdf) {
      ensureInst(Math.max(1, segs + 1));
      let n = segs;
      if (spine.length === 1 && tip) {
        writeInstance(inst, 0, tip, tip, INK, INK);
        n = 1;
      } else if (tip) {
        writeInstance(inst, n, tip, tip, INK, INK);
        n += 1;
      }
      sdf.upload(inst, n);
      sdf.draw(aabb);
      ctx.drawImage(sdf.canvas, 0, 0);
    } else if (holding && fallback) {
      fallback.blit(ctx);
      if (tip) {
        ctx.fillStyle = `rgb(${INK[0]}, ${INK[1]}, ${INK[2]})`;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, tip.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      fillMiterStroke(ctx, spine, tip, INK);
    }
  };

  return {
    attach(el) {
      host = el;
      peer = peerFactory(el);
      const w = Math.max(1, el.width || 1);
      const h = Math.max(1, el.height || 1);
      sdf = tryCreateSdfRenderer(w, h, peer);
      if (sdf) {
        backend = "webgl2";
        fallback = null;
      } else {
        backend = "canvas2d";
        fallback = createFallbackPainter(peer, w, h);
      }
      snap = peer(w, h);
      return backend;
    },
    down(s) {
      resetLive();
      drawing = true;
      ingest(s);
    },
    move(batch) {
      if (!drawing) return;
      for (const s of batch) ingest(s);
    },
    up(s) {
      if (drawing) ingest(s);
      const t0 = performance.now();
      blitLiveToSnap();
      const bakeMs = performance.now() - t0;
      drawing = false;
      holding = false;
      sdf?.clear();
      fallback?.clearLive();
      spine = [];
      segs = 0;
      tip = null;
      aabb = emptyAabb();
      return { bakeMs, bake: "catmull" };
    },
    paint() {
      const t0 = performance.now();
      syncSize();
      const tDraw = performance.now();
      composite();
      const drawMs = performance.now() - tDraw;
      return {
        frameMs: performance.now() - t0,
        pts: spine.length,
        segs,
        ekfMs: lastEkfMs,
        drawMs,
        hold: holding,
      };
    },
    clear() {
      resetLive();
      if (snap) {
        const sctx = snap.getContext("2d");
        sctx?.clearRect(0, 0, snap.width, snap.height);
      }
      if (host) {
        const ctx = host.getContext("2d");
        ctx?.clearRect(0, 0, host.width, host.height);
      }
    },
    destroy() {
      resetLive();
      sdf?.destroy();
      fallback?.destroy();
      sdf = null;
      fallback = null;
      snap = null;
      host = null;
      peer = null;
    },
  };
}
