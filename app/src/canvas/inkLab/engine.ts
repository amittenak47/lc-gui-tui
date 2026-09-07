/**
 * Ink lab engine. Host-owned overlay: attach / down / move / up / paint / clear.
 * Camera is the host view (zoom / scroll baked into sample + replay coords).
 * Excalidraw is not the ink surface.
 */

import { inkSlowness } from "../rasterInk";
import { INK_SMOOTHING_DEFAULT } from "../inkSmoothing";

import { bakeSpine, reshapeSpine } from "./bake";
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
import {
  capillaryRelax,
  growTipRadius,
  INK_RGB,
  labHoldGrow,
  labNibRadius,
  labPenDot,
  labPenNibOverlay,
  TIP_GROW,
  washRgb,
  type InkLabPen,
} from "./style";

export type { StrokeAabb } from "./instance";

export type InkLabBackend = "webgl2" | "canvas2d";
export type InkLabBake = "catmull" | "clothoid";

export type InkLabSample = {
  x: number;
  y: number;
  p: number;
  t: number;
};

export type InkLabPaintStats = {
  backend: InkLabBackend;
  frameMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
  /** False only when this frame remeshed the whole live stroke. */
  suffix: boolean;
  dirtyFrom: number;
  aabb: StrokeAabb;
};

export type InkLabHalt = {
  x: number;
  y: number;
  grow: number;
  p?: number;
  slow?: number;
};

export type InkLabUpResult = {
  bakeMs: number;
  bake: InkLabBake;
  points: SpineDot[];
  blotTipGrow: number;
  blotHalts: InkLabHalt[];
};

export type InkLabEngine = {
  attach(canvas: HTMLCanvasElement): InkLabBackend;
  setPen(pen: InkLabPen | null): void;
  down(s: InkLabSample): void;
  move(batch: InkLabSample[]): void;
  /**
   * Collapse the live tail to a chord from `anchorIndex`, keeping the
   * freehand prefix. Straight-ink toggle uses 0; Shift uses the index at
   * keydown. Next paint remeshes so the overlay does not keep the old tail.
   */
  clipLiveToChord(anchorIndex: number, current: InkLabSample): void;
  pointCount(): number;
  up(s?: InkLabSample): InkLabUpResult;
  paint(): InkLabPaintStats;
  /**
   * Copy the in-DOM host into the committed snap. Call once at pointerdown;
   * live composite is that snap plus the live SDF until lift.
   */
  captureSnap(): void;
  /**
   * Rebuild the committed snap (camera change, undo). Next {@link paint}
   * presents this plus any live SDF.
   */
  redrawSnap(paint: (ctx: CanvasRenderingContext2D) => void): void;
  /**
   * Replace the committed snap with SDF capsules for these overlay-space
   * spines. Undo / restore. Not the 2D miter strip. No-op while a live
   * stroke is down — replay belongs to lift / camera, not the nib rAF.
   */
  replaySpines(strokes: readonly SpineDot[][]): void;
  /** Stamp highlighter / eraser onto the committed snap without clearing it. */
  paintOntoSnap(paint: (ctx: CanvasRenderingContext2D) => void): void;
  /** Drop the live stroke. Keep the committed snap. */
  cancelStroke(): void;
  clear(): void;
  destroy(): void;
};

export type InkLabEngineOpts = {
  clothoid?: boolean;
  capillary?: boolean;
  /** When false, skip WebGL even if `getContext("webgl2")` works. Tests use this. */
  sdf?: boolean;
};

export const DISTANCE_GATE_CSS = 2.5;
const HOLD_TICK_MS = 32;
const HOLD_PLATEAU_EPS = 1e-3;

function holdCapRadius(base: number, blot: number): number {
  const t = Math.max(0, Math.min(1, blot));
  return base * (1 + (TIP_GROW - 1) * t);
}

function inkOf(d: SpineDot): [number, number, number] {
  return d.rgb ?? INK_RGB;
}

function cloneDot(d: SpineDot): SpineDot {
  return {
    x: d.x,
    y: d.y,
    r: d.r,
    rgb: d.rgb ? [d.rgb[0], d.rgb[1], d.rgb[2]] : undefined,
    a: d.a,
    p: d.p,
    slow: d.slow,
  };
}

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

function hopAabb(a: SpineDot, b: SpineDot): StrokeAabb {
  const box = emptyAabb();
  expandAabb(box, a);
  expandAabb(box, b);
  return box;
}

function dprOf(canvas: HTMLCanvasElement): number {
  const css = Math.max(1, canvas.clientWidth || canvas.width);
  return Math.max(1, canvas.width / css);
}

function nibRadius(vx: number, vy: number, dpr: number, pressure: number): number {
  return labNibRadius(vx, vy, dpr, pressure, 1);
}

export function createInkLabEngine(opts: InkLabEngineOpts = {}): InkLabEngine {
  const useClothoid = opts.clothoid === true;
  const useCapillary = opts.capillary === true;
  const allowSdf = opts.sdf !== false;
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
  /** Instances already in the SDF framebuffer this stroke. */
  let sdfLive = 0;
  let sdfFull = false;
  let lastSuffix = true;
  let paintedSegs = 0;
  let aabb: StrokeAabb = emptyAabb();
  let drawing = false;
  let holding = false;
  let tip: SpineDot | null = null;
  let lastEkfMs = 0;
  let pen: InkLabPen | null = null;
  let consumed = 0;
  let holdTicks = 0;
  let holdBase: SpineDot | null = null;
  let lastHoldWall = 0;
  /** Pool reached cap; do not re-arm until the pen hops. */
  let holdPlateau = false;
  let blotTipGrow = 0;
  let blotHalts: InkLabHalt[] = [];

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
    sdfLive = 0;
    sdfFull = false;
    paintedSegs = 0;
    aabb = emptyAabb();
    drawing = false;
    holding = false;
    tip = null;
    ekf = createEkf();
    consumed = 0;
    holdTicks = 0;
    holdBase = null;
    lastHoldWall = 0;
    holdPlateau = false;
    blotTipGrow = 0;
    blotHalts = [];
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
    const sdfW = sdf?.canvas.width ?? w;
    const sdfH = sdf?.canvas.height ?? h;
    sdf?.resize(w, h);
    fallback?.resize(w, h);
    if (drawing && sdf && (sdfW !== w || sdfH !== h)) {
      sdfFull = true;
      sdfLive = 0;
    }
  };

  const styledDot = (
    x: number,
    y: number,
    vx: number,
    vy: number,
    dpr: number,
    pressure: number,
    growT: number,
  ): SpineDot => {
    if (pen) {
      const styled = labPenDot(pen, vx, vy, dpr, pressure, consumed, growT);
      return {
        x,
        y,
        r: styled.r,
        rgb: styled.rgb,
        a: styled.a,
        p: pressure,
        slow: styled.slow,
      };
    }
    return {
      x,
      y,
      r: nibRadius(vx, vy, dpr, pressure),
      rgb: washRgb(vx, vy, dpr),
      p: pressure,
      slow: inkSlowness(Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6)),
    };
  };

  const stampHalt = (at: SpineDot, grow: number) => {
    if (grow < 1e-3) return;
    const last = blotHalts[blotHalts.length - 1];
    if (last && Math.hypot(last.x - at.x, last.y - at.y) < 4) {
      last.grow = Math.max(last.grow, grow);
      if (at.p != null && at.p > (last.p ?? -1)) last.p = at.p;
      if (at.slow != null) {
        last.slow = last.slow != null ? Math.max(last.slow, at.slow) : at.slow;
      }
      return;
    }
    blotHalts.push({
      x: at.x,
      y: at.y,
      grow,
      p: at.p,
      slow: at.slow,
    });
  };

  const armHold = (at: SpineDot, now: number) => {
    if (holding || holdPlateau) return;
    holding = true;
    holdTicks = 0;
    holdBase = cloneDot(at);
    lastHoldWall = now;
  };

  const endHoldPool = () => {
    holding = false;
    holdPlateau = true;
  };

  const applyHoldGrow = (now: number) => {
    if (!holding || !pen || !holdBase || !tip) return;
    const dt = now - lastHoldWall;
    if (dt < HOLD_TICK_MS && holdTicks > 0) return;
    const extra = Math.max(1, Math.floor(Math.max(dt, HOLD_TICK_MS) / HOLD_TICK_MS));
    holdTicks += extra;
    lastHoldWall = now;
    const grown = labHoldGrow(holdBase.r, tip.r, pen.speedBlotBlend);
    if (holdBase.r > 1e-6) {
      blotTipGrow = Math.max(blotTipGrow, (grown / holdBase.r - 1) / (TIP_GROW - 1));
    }
    const styled = labPenDot(
      pen,
      0,
      0,
      pen.dpr,
      holdBase.p ?? 0.5,
      consumed,
      blotTipGrow,
    );
    tip = {
      ...holdBase,
      r: grown,
      rgb: styled.rgb,
      a: styled.a,
      slow: styled.slow,
    };
    const last = spine[spine.length - 1];
    if (last) {
      last.r = grown;
      last.rgb = styled.rgb;
      last.a = styled.a;
      last.slow = styled.slow;
    }
    expandAabb(aabb, tip);
    if (grown >= holdCapRadius(holdBase.r, pen.speedBlotBlend) - HOLD_PLATEAU_EPS) {
      endHoldPool();
    }
  };

  const appendSpine = (dot: SpineDot) => {
    const prev = spine[spine.length - 1];
    spine.push(dot);
    expandAabb(aabb, dot);
    tip = dot;
    if (pen && prev) {
      consumed += Math.hypot(dot.x - prev.x, dot.y - prev.y) / labPenNibOverlay(pen);
    }
    holding = false;
    if (!prev) return;
    ensureInst(segs + 1);
    writeInstance(inst, segs, prev, dot, inkOf(prev), inkOf(dot));
    segs += 1;
    fallback?.appendHop(prev, dot, inkOf(dot));
  };

  const ingest = (s: InkLabSample) => {
    const t0 = performance.now();
    const dpr = pen?.dpr ?? (host ? dprOf(host) : 1);
    const gate = DISTANCE_GATE_CSS * dpr;
    if (spine.length === 0) {
      ekf.reset(s.x, s.y, s.t);
      const first = styledDot(s.x, s.y, 0, 0, dpr, s.p, 0);
      spine.push(first);
      expandAabb(aabb, first);
      tip = first;
      fallback?.beginStroke();
      lastEkfMs = performance.now() - t0;
      return;
    }
    const f = ekf.step(s.x, s.y, s.t);
    const dot = styledDot(f.x, f.y, f.vx, f.vy, dpr, s.p, 0);
    lastEkfMs = performance.now() - t0;
    const last = spine[spine.length - 1]!;
    const dist = Math.hypot(dot.x - last.x, dot.y - last.y);
    if (dist < gate) {
      const now = typeof performance !== "undefined" ? performance.now() : s.t;
      if (pen) {
        if (pen.speedBlotBlend > 1e-3) {
          armHold(last, now);
          applyHoldGrow(now);
        }
      } else if (!holdPlateau) {
        if (!holding) {
          holding = true;
          holdTicks = 0;
          holdBase = { ...last };
          lastHoldWall = now;
        }
        const grown = growTipRadius(last.r, tip?.r ?? last.r);
        tip = {
          x: last.x,
          y: last.y,
          r: Math.max(dot.r, grown),
          rgb: last.rgb,
          a: last.a,
          p: last.p,
          slow: last.slow,
        };
        expandAabb(aabb, tip);
        if (holdBase && grown >= holdCapRadius(holdBase.r, 1) - HOLD_PLATEAU_EPS) {
          endHoldPool();
        }
      }
      return;
    }
    if (holding || holdPlateau) {
      if (tip) last.r = tip.r;
      if (blotTipGrow > 1e-3) stampHalt(last, blotTipGrow);
      holding = false;
      holdTicks = 0;
      holdBase = null;
      holdPlateau = false;
      blotTipGrow = 0;
    }
    appendSpine(dot);
  };

  const unionAabb = (dst: StrokeAabb, src: StrokeAabb) => {
    if (!Number.isFinite(src.minX)) return;
    dst.minX = Math.min(dst.minX, src.minX);
    dst.minY = Math.min(dst.minY, src.minY);
    dst.maxX = Math.max(dst.maxX, src.maxX);
    dst.maxY = Math.max(dst.maxY, src.maxY);
  };

  const clipLiveToChord = (anchorIndex: number, current: InkLabSample) => {
    if (!drawing) return;
    if (spine.length === 0) {
      ingest(current);
      return;
    }
    const cut = Math.max(0, Math.min(anchorIndex, spine.length - 1));
    const kept = spine.slice(0, cut + 1).map(cloneDot);
    const prevBox = { ...aabb };
    const savedGrow = blotTipGrow;
    const savedHalts = blotHalts.map((h) => ({ ...h }));
    spine = [];
    segs = 0;
    sdfLive = 0;
    sdfFull = true;
    paintedSegs = 0;
    aabb = emptyAabb();
    tip = null;
    consumed = 0;
    holding = false;
    holdTicks = 0;
    holdBase = null;
    lastHoldWall = 0;
    holdPlateau = false;
    ekf = createEkf();
    sdf?.clear();
    fallback?.clearLive();
    fallback?.beginStroke();
    blotTipGrow = savedGrow;
    blotHalts = savedHalts;
    const lastKept = kept[kept.length - 1]!;
    ekf.reset(lastKept.x, lastKept.y, current.t);
    for (const d of kept) appendSpine(d);
    ingest(current);
    unionAabb(aabb, prevBox);
  };

  const remesh = (points: readonly SpineDot[]) => {
    segs = 0;
    aabb = emptyAabb();
    fallback?.beginStroke();
    if (points.length === 0) {
      tip = null;
      return;
    }
    expandAabb(aabb, points[0]!);
    tip = points[points.length - 1]!;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      ensureInst(segs + 1);
      writeInstance(inst, segs, a, b, inkOf(a), inkOf(b));
      segs += 1;
      fallback?.appendHop(a, b, inkOf(b));
      expandAabb(aabb, b);
    }
  };

  const applyBaked = (points: SpineDot[]) => {
    spine = points;
    remesh(points);
  };

  const blitLiveToSnap = () => {
    if (!snap) return;
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    if (sdf) {
      ensureInst(segs + 1);
      let n = segs;
      if (tip) {
        writeInstance(inst, n, tip, tip, inkOf(tip), inkOf(tip));
        n += 1;
      }
      sdf.upload(inst, n);
      sdf.draw(aabb);
      sctx.drawImage(sdf.canvas, 0, 0);
    } else {
      fillMiterStroke(sctx, spine, tip, INK_RGB);
    }
  };

  const drawDots = (points: readonly SpineDot[]) => {
    if (!host) return;
    const ctx = host.getContext("2d");
    if (!ctx) return;
    if (points.length === 0) return;
    let n = 0;
    const box = emptyAabb();
    expandAabb(box, points[0]!);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      ensureInst(n + 1);
      writeInstance(inst, n, a, b, inkOf(a), inkOf(b));
      n += 1;
      expandAabb(box, b);
    }
    const end = points[points.length - 1]!;
    if (sdf) {
      sdf.upload(inst, n);
      sdf.draw(box);
      ctx.drawImage(sdf.canvas, 0, 0);
    } else {
      fillMiterStroke(ctx, points, end, INK_RGB);
    }
    ctx.globalAlpha = end.a ?? 1;
    ctx.fillStyle = `rgb(${inkOf(end)[0]}, ${inkOf(end)[1]}, ${inkOf(end)[2]})`;
    ctx.beginPath();
    ctx.arc(end.x, end.y, end.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const lastLiveDirtyAabb = (): StrokeAabb => {
    const box = emptyAabb();
    if (tip) expandAabb(box, tip);
    const from = Math.max(0, Math.min(paintedSegs, spine.length - 1));
    for (let i = from; i < spine.length; i++) {
      expandAabb(box, spine[i]!);
    }
    return box;
  };

  const drawTip = (ctx: CanvasRenderingContext2D) => {
    if (!tip) return;
    const rgb = inkOf(tip);
    ctx.globalAlpha = tip.a ?? 1;
    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, tip.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const flushSdfLive = (): boolean => {
    if (!sdf) return true;
    if (segs < 1) {
      if (tip) {
        ensureInst(1);
        writeInstance(inst, 0, tip, tip, inkOf(tip), inkOf(tip));
        sdf.upload(inst, 1);
        sdf.draw(aabb);
      }
      sdfLive = 0;
      return true;
    }
    let suffix = true;
    if (sdfFull || sdfLive > segs) {
      sdf.upload(inst, segs);
      sdf.draw(aabb);
      sdfLive = segs;
      sdfFull = false;
      suffix = false;
    } else {
      while (sdfLive < segs) {
        const a = spine[sdfLive];
        const b = spine[sdfLive + 1];
        if (!a || !b) break;
        sdf.append(inst, sdfLive, hopAabb(a, b));
        sdfLive += 1;
      }
    }
    return suffix;
  };

  const composite = (): boolean => {
    lastSuffix = true;
    if (!host) return lastSuffix;
    const ctx = host.getContext("2d");
    if (!ctx) return lastSuffix;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, host.width, host.height);
    if (snap) ctx.drawImage(snap, 0, 0);
    if (!drawing) return lastSuffix;
    // While Writing only. Off / On Lift stay on the suffix path.
    const liveSmooth =
      pen?.smoothingMode === "live" && (pen.smoothing ?? 0) > 0 && spine.length >= 3;
    if (liveSmooth) {
      drawDots(reshapeSpine(spine, pen!.smoothing ?? 0));
      remesh(spine);
      sdfLive = 0;
      sdfFull = true;
      lastSuffix = false;
      return lastSuffix;
    }
    if (sdf) {
      lastSuffix = flushSdfLive();
      ctx.drawImage(sdf.canvas, 0, 0);
      drawTip(ctx);
    } else if (fallback) {
      fallback.blit(ctx);
      drawTip(ctx);
      lastSuffix = true;
    } else {
      fillMiterStroke(ctx, spine, tip, INK_RGB);
      lastSuffix = false;
    }
    return lastSuffix;
  };

  return {
    attach(el) {
      const sameHost = host === el;
      const sdfOk = Boolean(sdf && !sdf.isLost());
      if (sameHost && sdfOk) {
        syncSize();
        return backend;
      }
      if (sameHost && backend === "canvas2d" && fallback && !sdf) {
        syncSize();
        return backend;
      }
      sdf?.destroy();
      fallback?.destroy();
      sdf = null;
      fallback = null;
      host = el;
      peer = peerFactory(el);
      const w = Math.max(1, el.width || 1);
      const h = Math.max(1, el.height || 1);
      if (allowSdf) {
        sdf = tryCreateSdfRenderer(w, h, peer);
      }
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
    setPen(next) {
      pen = next;
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
    clipLiveToChord,
    pointCount() {
      return spine.length;
    },
    up(s) {
      if (drawing && s) ingest(s);
      if ((holding || holdPlateau) && tip && spine.length > 0) {
        const last = spine[spine.length - 1]!;
        last.r = tip.r;
        last.rgb = tip.rgb;
        last.a = tip.a;
        last.slow = tip.slow;
        if (blotTipGrow > 1e-3) stampHalt(last, blotTipGrow);
      }
      const t0 = performance.now();
      const clothoid = pen?.clothoid ?? useClothoid;
      const capillary = pen?.capillary ?? useCapillary;
      const baked = bakeSpine(spine, {
        clothoid,
        smoothing: pen?.smoothing ?? INK_SMOOTHING_DEFAULT,
      });
      const points = capillary ? capillaryRelax(baked.points) : baked.points;
      const exported = points.map(cloneDot);
      const exportedGrow = blotTipGrow;
      const exportedHalts = blotHalts.map((h) => ({ ...h }));
      applyBaked(points);
      blitLiveToSnap();
      const bakeMs = performance.now() - t0;
      drawing = false;
      holding = false;
      holdPlateau = false;
      sdf?.clear();
      fallback?.clearLive();
      spine = [];
      segs = 0;
      sdfLive = 0;
      sdfFull = false;
      paintedSegs = 0;
      tip = null;
      aabb = emptyAabb();
      return {
        bakeMs,
        bake: baked.bake,
        points: exported,
        blotTipGrow: exportedGrow,
        blotHalts: exportedHalts,
      };
    },
    paint() {
      const t0 = performance.now();
      if (host && sdf?.isLost()) this.attach(host);
      if (drawing && holding && pen) applyHoldGrow(t0);
      syncSize();
      const tDraw = performance.now();
      const suffix = composite();
      const drawMs = performance.now() - tDraw;
      const dirty = lastLiveDirtyAabb();
      paintedSegs = segs;
      return {
        backend,
        frameMs: performance.now() - t0,
        pts: spine.length,
        segs,
        ekfMs: lastEkfMs,
        drawMs,
        hold: holding,
        suffix,
        dirtyFrom: suffix ? Math.max(0, segs > 0 ? segs - 1 : 0) : 0,
        aabb: dirty,
      };
    },
    captureSnap() {
      if (!host) return;
      syncSize();
      if (!snap || !peer) return;
      const sctx = snap.getContext("2d");
      if (!sctx) return;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, snap.width, snap.height);
      sctx.drawImage(host, 0, 0);
    },
    redrawSnap(paint) {
      if (!host || !peer) return;
      syncSize();
      if (!snap) snap = peer(host.width, host.height);
      if (!snap) return;
      const sctx = snap.getContext("2d");
      if (!sctx) return;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, snap.width, snap.height);
      paint(sctx);
    },
    replaySpines(strokes) {
      if (drawing) return;
      if (!host || !peer) return;
      syncSize();
      if (!snap) snap = peer(host.width, host.height);
      if (!snap) return;
      const sctx = snap.getContext("2d");
      sctx?.setTransform(1, 0, 0, 1, 0, 0);
      sctx?.clearRect(0, 0, snap.width, snap.height);
      drawing = false;
      holding = false;
      for (const stroke of strokes) {
        if (stroke.length === 0) continue;
        applyBaked(stroke.map(cloneDot));
        blitLiveToSnap();
        sdf?.clear();
        fallback?.clearLive();
      }
      spine = [];
      segs = 0;
      sdfLive = 0;
      sdfFull = false;
      paintedSegs = 0;
      tip = null;
      aabb = emptyAabb();
    },
    paintOntoSnap(paint) {
      if (!snap) return;
      const sctx = snap.getContext("2d");
      if (!sctx) return;
      paint(sctx);
    },
    cancelStroke() {
      resetLive();
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
      pen = null;
    },
  };
}
