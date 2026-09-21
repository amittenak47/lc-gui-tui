/**
 * Ink lab engine. Host-owned overlay: attach / down / move / up / paint / clear.
 * Camera is the host view (zoom / scroll baked into sample + replay coords).
 * Excalidraw is not the ink surface.
 */

import { inkSlowness, type ScenePoint } from "../rasterInk";
import { INK_SMOOTHING_DEFAULT, type LiveSmoothCache } from "../inkSmoothing";

import { bakeSpine, reshapeLiveSpine } from "./bake";
import { seedSpineHop } from "./seedHop";
import { CLIP_BLIT_PAD, clipBlitRect, intersectPixelRects, type PixelRect } from "./clipBlit";
import { exposedShiftRects, shiftClearsSnap, spineHitsRects } from "./cameraShift";
import { createEkf, type EkfFilter } from "./ekf";
import { fillMiterStroke } from "./fallback";
import { createLiveRibbon } from "./ribbon";
import {
  emptyAabb,
  expandAabb,
  type SpineDot,
  type StrokeAabb,
} from "./instance";
import { stampLiveSamples } from "./sampleTime";
import {
  capillaryRelax,
  growTipRadius,
  INK_RGB,
  labFadeVel,
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

export type InkLabSnapPatch = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** GPU/canvas copy. Avoids a synchronous getImageData readback on lift. */
  image: CanvasImageSource;
};

export type InkLabUpResult = {
  bakeMs: number;
  bake: InkLabBake;
  points: SpineDot[];
  blotTipGrow: number;
  blotHalts: InkLabHalt[];
  /** Pixels under this stroke before it was blitted. Undo restores this. */
  undoPatch: InkLabSnapPatch | null;
};

export type InkLabBakeOptions = {
  smoothing: number;
  clothoid: boolean;
  capillary: boolean;
};

export type InkLabRawLiftResult = InkLabUpResult & {
  /** Raw overlay-space input for the off-thread final bake. */
  bakeInput: SpineDot[];
  bakeOptions: InkLabBakeOptions;
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
  /** End the pointer synchronously, but leave the full Catmull bake to a worker. */
  liftRaw(s?: InkLabSample): InkLabRawLiftResult;
  paint(): InkLabPaintStats;
  /**
   * Copy the in-DOM host into the committed snap. Call once at pointerdown;
   * live composite is that snap plus the live ribbon until lift.
   */
  captureSnap(): void;
  /**
   * Rebuild the committed snap (camera change, undo). Next {@link paint}
   * presents this plus any live ribbon.
   */
  redrawSnap(paint: (ctx: CanvasRenderingContext2D) => void): void;
  /** Replace and present only a device-pixel region; leave other live pixels alone. */
  redrawSnapRegion(box: { x: number; y: number; w: number; h: number }, paint: (ctx: CanvasRenderingContext2D) => void): void;
  /**
   * Replace the committed snap with ribbons for these overlay-space
   * spines. Same strip geometry as live paint. No-op while a live
   * stroke is down — replay belongs to lift / camera, not the nib rAF.
   */
  replaySpines(strokes: readonly SpineDot[][]): void;
  /** Draw spines onto the committed snap without clearing it. Redo of one pen. */
  appendSpines(strokes: readonly SpineDot[][], clips?: readonly PixelRect[]): void;
  /**
   * Slide the committed snap by a camera delta. Returns the newly exposed
   * strips to fill, or null when the jump has no overlap and must remesh.
   */
  shiftSnap(dx: number, dy: number): PixelRect[] | null;
  /** Copy snap pixels in `box`, or the whole snap. */
  copySnapPatch(box?: StrokeAabb): InkLabSnapPatch | null;
  /** Put a {@link copySnapPatch} back. Undo of one stroke. */
  restoreSnapPatch(patch: InkLabSnapPatch): void;
  /** Replace the last idle stroke after a worker bake; caller guards history/camera. */
  replaceLastStroke(patch: InkLabSnapPatch, points: SpineDot[]): InkLabSnapPatch | null;
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
  /** Legacy caller option. Board ink uses a tail-only Canvas2D ribbon. */
  sdf?: boolean;
};

export const DISTANCE_GATE_CSS = 2.5;

/** How far the next stamp may sit. Thin nibs step closer so they stay a line. */
export function labStampGatePx(radiusPx: number, dpr: number): number {
  const pix = Math.max(dpr, 1e-6);
  const cap = DISTANCE_GATE_CSS * pix;
  const byNib = Math.max(0.35 * pix, radiusPx * 0.85);
  return Math.min(cap, byNib);
}
const HOLD_TICK_MS = 32;
const HOLD_PLATEAU_EPS = 1e-3;

function wallNow(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

function holdCapRadius(base: number, blot: number): number {
  const t = Math.max(0, Math.min(1, blot));
  return base * (1 + (TIP_GROW - 1) * t);
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
  let host: HTMLCanvasElement | null = null;
  const backend: InkLabBackend = "canvas2d";
  let ribbon: ReturnType<typeof createLiveRibbon> | null = null;
  let snap: HTMLCanvasElement | null = null;
  let peer: ReturnType<typeof peerFactory> | null = null;
  let ekf: EkfFilter = createEkf();
  let spine: SpineDot[] = [];
  let segs = 0;
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
  let lastStamp = 0;
  let lastWall = 0;
  /** Last presented tail bounds; never used to choose a growing live copy. */
  let liveRedrawBox: StrokeAabb | null = null;
  let liveSmoothCache: LiveSmoothCache | null = null;
  const liveSmoothScene: ScenePoint[] = [];
  /** Camera-shift fill: blit only into these destination strips. */
  let blitClip: readonly PixelRect[] | null = null;

  const resetLive = () => {
    spine = [];
    previousInputDot = null;
    segs = 0;
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
    lastStamp = 0;
    lastWall = 0;
    liveRedrawBox = null;
    liveSmoothCache = null;
    liveSmoothScene.length = 0;
    ribbon?.clear();
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
    expandAabb(aabb, { ...tip, r: tip.r * 2 });
    if (grown >= holdCapRadius(holdBase.r, pen.speedBlotBlend) - HOLD_PLATEAU_EPS) {
      endHoldPool();
    }
  };

  const appendSpine = (dot: SpineDot) => {
    const prev = spine[spine.length - 1];
    spine.push(dot);
    expandAabb(aabb, { ...dot, r: dot.r * 2 });
    tip = dot;
    if (pen && prev) {
      consumed += Math.hypot(dot.x - prev.x, dot.y - prev.y) / labPenNibOverlay(pen);
    }
    holding = false;
    if (!prev) return;
    segs += 1;
  };

  let previousInputDot: SpineDot | null = null;
  const ingest = (s: InkLabSample) => {
    const t0 = performance.now();
    const dpr = pen?.dpr ?? (host ? dprOf(host) : 1);
    if (spine.length === 0) {
      ekf.reset(s.x, s.y, s.t);
      const first = styledDot(s.x, s.y, 0, 0, dpr, s.p, 0);
      spine.push(first);
      expandAabb(aabb, { ...first, r: first.r * 2 });
      tip = first;
      lastEkfMs = performance.now() - t0;
      return;
    }
    const prev = ekf.current();
    const last = spine[spine.length - 1]!;
    const f = ekf.step(s.x, s.y, s.t);
    const dtMs = prev ? Math.max(0, f.t - prev.t) : 0;
    const fadeV = labFadeVel(s.x - last.x, s.y - last.y, dtMs);
    const dot = styledDot(f.x, f.y, fadeV.vx, fadeV.vy, dpr, s.p, 0);
    lastEkfMs = performance.now() - t0;
    const dist = Math.hypot(dot.x - last.x, dot.y - last.y);
    const gate = labStampGatePx(last.r, dpr);
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
        expandAabb(aabb, { ...tip, r: tip.r * 2 });
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
    // First sample is planted at rest. Speed ink would leave a standstill
    // disc; borrow this hop's heading so the start matches the body.
    if (spine.length === 1) {
      const origin = spine[0]!;
      const headed = styledDot(
        origin.x,
        origin.y,
        fadeV.vx,
        fadeV.vy,
        dpr,
        origin.p ?? s.p,
        0,
      );
      spine[0] = {
        ...origin,
        r: headed.r,
        rgb: headed.rgb,
        a: headed.a,
        slow: headed.slow,
      };
    }
    // Plant Catmull samples off a turning hop in every smoothing mode so
    // the live stroke is round; a sparse tablet polyline stays a polyline.
    // Control points are accepted input samples, never inserted spline seeds.
    // A seed just behind the tip shortens the incoming tangent to nearly zero.
    for (const seed of seedSpineHop(previousInputDot, last, dot)) appendSpine(seed);
    previousInputDot = last;
  };

  const unionAabb = (dst: StrokeAabb, src: StrokeAabb) => {
    if (!Number.isFinite(src.minX)) return;
    dst.minX = Math.min(dst.minX, src.minX);
    dst.minY = Math.min(dst.minY, src.minY);
    dst.maxX = Math.max(dst.maxX, src.maxX);
    dst.maxY = Math.max(dst.maxY, src.maxY);
  };

  const ingestBatch = (batch: readonly InkLabSample[]) => {
    if (batch.length === 0) return;
    const wall = wallNow();
    const stamped = stampLiveSamples(batch, lastStamp, wall, lastWall);
    lastWall = wall;
    for (const s of stamped) {
      ingest(s);
      lastStamp = s.t;
    }
  };

  const clipLiveToChord = (anchorIndex: number, current: InkLabSample) => {
    if (!drawing) return;
    if (spine.length === 0) {
      ingestBatch([current]);
      return;
    }
    const cut = Math.max(0, Math.min(anchorIndex, spine.length - 1));
    const kept = spine.slice(0, cut + 1).map(cloneDot);
    const prevBox = { ...aabb };
    const savedGrow = blotTipGrow;
    const savedHalts = blotHalts.map((h) => ({ ...h }));
    liveSmoothCache = null;
    liveSmoothScene.length = 0;
    spine = [];
    segs = 0;
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
    ribbon?.clear();
    blotTipGrow = savedGrow;
    blotHalts = savedHalts;
    const wall = wallNow();
    const stamped = stampLiveSamples([current], lastStamp, wall, lastWall);
    lastWall = wall;
    const next = stamped[0]!;
    lastStamp = next.t;
    const lastKept = kept[kept.length - 1]!;
    previousInputDot = null;
    ekf.reset(lastKept.x, lastKept.y, next.t);
    for (const d of kept) appendSpine(d);
    ingest(next);
    unionAabb(aabb, prevBox);
    if (host) {
      const ctx = host.getContext("2d");
      const clip = clipBlitRect(prevBox, host.width, host.height, CLIP_BLIT_PAD);
      if (ctx && clip) presentHost(ctx, clip, snap);
    }
  };

  const remesh = (points: readonly SpineDot[]) => {
    segs = 0;
    aabb = emptyAabb();
    if (points.length === 0) {
      tip = null;
      return;
    }
    expandAabb(aabb, { ...points[0]!, r: points[0]!.r * 2 });
    tip = points[points.length - 1]!;
    for (let i = 1; i < points.length; i++) {
      const b = points[i]!;
      segs += 1;
      expandAabb(aabb, { ...b, r: b.r * 2 });
    }
  };

  const applyBaked = (points: SpineDot[]) => {
    spine = points;
    remesh(points);
  };

  const copySnapPatch = (box?: StrokeAabb): InkLabSnapPatch | null => {
    if (!snap || !peer) return null;
    const rect = box
      ? clipBlitRect(box, snap.width, snap.height, CLIP_BLIT_PAD)
      : { x: 0, y: 0, w: snap.width, h: snap.height };
    if (!rect) return null;
    const image = peer(rect.w, rect.h);
    const pctx = image?.getContext("2d");
    if (!image || !pctx) return null;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, rect.w, rect.h);
    pctx.drawImage(
      snap,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      rect.w,
      rect.h,
    );
    return {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      image,
    };
  };

  const restoreSnapPatch = (patch: InkLabSnapPatch) => {
    if (!snap) return;
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(patch.x, patch.y, patch.w, patch.h);
    sctx.drawImage(patch.image, patch.x, patch.y);
  };

  const shiftSnap = (dx: number, dy: number): PixelRect[] | null => {
    if (drawing) return null;
    if (!host || !peer) return null;
    syncSize();
    if (!snap) snap = peer(host.width, host.height);
    if (!snap) return null;
    const idx = Math.round(dx);
    const idy = Math.round(dy);
    if (idx === 0 && idy === 0) return [];
    if (shiftClearsSnap(snap.width, snap.height, idx, idy)) return null;
    const tmp = peer(snap.width, snap.height);
    if (!tmp) return null;
    tmp.width = snap.width;
    tmp.height = snap.height;
    const tctx = tmp.getContext("2d");
    const sctx = snap.getContext("2d");
    if (!tctx || !sctx) return null;
    tctx.drawImage(snap, 0, 0);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, snap.width, snap.height);
    sctx.drawImage(tmp, idx, idy);
    return exposedShiftRects(snap.width, snap.height, idx, idy);
  };

  const resetAfterBlit = () => {
    spine = [];
    segs = 0;
    paintedSegs = 0;
    tip = null;
    aabb = emptyAabb();
  };

  const blitSpinesOntoSnap = (strokes: readonly SpineDot[][], clear: boolean) => {
    if (drawing) return;
    if (!host || !peer) return;
    syncSize();
    if (!snap) snap = peer(host.width, host.height);
    if (!snap) return;
    if (clear) {
      const sctx = snap.getContext("2d");
      sctx?.setTransform(1, 0, 0, 1, 0, 0);
      sctx?.clearRect(0, 0, snap.width, snap.height);
    }
    drawing = false;
    holding = false;
    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      if (blitClip && !spineHitsRects(stroke, blitClip)) continue;
      applyBaked(stroke.map(cloneDot));
      blitLiveToSnap();
      ribbon?.clear();
    }
    resetAfterBlit();
  };

  const destClipsFor = (
    strokeClip: PixelRect | null,
    width: number,
    height: number,
  ): PixelRect[] => {
    if (!blitClip || blitClip.length === 0) return strokeClip ? [strokeClip] : [];
    const src = strokeClip ?? { x: 0, y: 0, w: width, h: height };
    const dests: PixelRect[] = [];
    for (const clip of blitClip) {
      const hit = intersectPixelRects(src, clip);
      if (hit) dests.push(hit);
    }
    return dests;
  };

  /**
   * Freeze the live host into the committed snap. A remesh of the raw
   * samples (or a second Chaikin) is what turned a dark overlapping hatch
   * into a thin polygon after lift.
   */
  const blitHostToSnap = () => {
    if (!host || !snap) return;
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    const rect = clipBlitRect(aabb, snap.width, snap.height, CLIP_BLIT_PAD);
    if (!rect) return;
    // Replace the stroke footprint. Source-over of the entire host deposits
    // every older antialiased edge again on each lift and makes it darken.
    sctx.save();
    sctx.beginPath();
    sctx.rect(rect.x, rect.y, rect.w, rect.h);
    sctx.clip();
    sctx.globalCompositeOperation = "copy";
    sctx.drawImage(host, 0, 0);
    sctx.restore();
  };

  const blitLiveToSnap = () => {
    if (!snap) return;
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    const strokeClip = clipBlitRect(aabb, snap.width, snap.height, CLIP_BLIT_PAD);
    const dests = destClipsFor(strokeClip, snap.width, snap.height);
    if (dests.length === 0 && blitClip) return;
    if (dests.length > 0) {
      sctx.save();
      sctx.beginPath();
      for (const clip of dests) sctx.rect(clip.x, clip.y, clip.w, clip.h);
      sctx.clip();
      fillMiterStroke(sctx, spine, tip, INK_RGB);
      sctx.restore();
    } else {
      fillMiterStroke(sctx, spine, tip, INK_RGB);
    }
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

  const presentHost = (
    ctx: CanvasRenderingContext2D,
    clip: { x: number; y: number; w: number; h: number } | null,
    src: CanvasImageSource | null,
  ) => {
    if (!host) return;
    if (!clip) {
      if (src) {
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(src, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      } else ctx.clearRect(0, 0, host.width, host.height);
      return;
    }
    if (src) {
      ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
      ctx.drawImage(src, clip.x, clip.y, clip.w, clip.h, clip.x, clip.y, clip.w, clip.h);
    } else {
      ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
    }
  };

  const composite = (): boolean => {
    lastSuffix = true;
    if (!host) return lastSuffix;
    const ctx = host.getContext("2d");
    if (!ctx) return lastSuffix;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!drawing) {
      presentHost(ctx, null, snap);
      return lastSuffix;
    }
    // Catmull turn seeds are always present. Chaikin only runs live when asked.
    const strength = pen?.smoothing ?? 0;
    const liveSmooth = pen?.smoothingMode === "live" && strength > 0 && spine.length >= 3;
    let points: readonly SpineDot[] = spine;
    let stableTo = Math.max(0, spine.length - 3);
    if (liveSmooth) {
      const reshaped = reshapeLiveSpine(spine, strength, liveSmoothCache, liveSmoothScene);
      liveSmoothCache = reshaped.cache;
      points = reshaped.points;
      // Keep a neighbour past the frozen join for its miter normal.
      stableTo = Math.max(0, reshaped.from - 1);
    }
    if (ribbon) {
      liveRedrawBox = ribbon.paint(host, snap, points, stableTo);
      unionAabb(aabb, liveRedrawBox);
    }
    return lastSuffix;
  };

  type LiftState = {
    raw: SpineDot[];
    grow: number;
    halts: InkLabHalt[];
    options: InkLabBakeOptions;
  };

  const beginLift = (s?: InkLabSample): LiftState => {
    if (drawing && s) ingestBatch([s]);
    if ((holding || holdPlateau) && tip && spine.length > 0) {
      const last = spine[spine.length - 1]!;
      last.r = tip.r;
      last.rgb = tip.rgb;
      last.a = tip.a;
      last.slow = tip.slow;
      if (blotTipGrow > 1e-3) stampHalt(last, blotTipGrow);
    }
    return {
      raw: spine.map(cloneDot),
      grow: blotTipGrow,
      halts: blotHalts.map((halt) => ({ ...halt })),
      options: {
        smoothing: pen?.smoothing ?? INK_SMOOTHING_DEFAULT,
        clothoid: pen?.clothoid ?? useClothoid,
        capillary: pen?.capillary ?? useCapillary,
      },
    };
  };

  const finishLift = (
    state: LiftState,
    points: SpineDot[],
    bake: InkLabBake,
    bakeMs: number,
    keepUndoPatch: boolean,
    keepLivePixels: boolean,
  ): InkLabUpResult => {
    if (keepLivePixels) {
      // Host already has the live composite after a paint. Re-presenting the
      // empty snap punches the frozen prefix and the tail redraw cannot fill it.
      composite();
    } else {
      applyBaked(points);
    }
    const undoPatch = keepUndoPatch && points.length > 0 ? copySnapPatch(aabb) : null;
    if (keepLivePixels) blitHostToSnap();
    else blitLiveToSnap();
    drawing = false;
    holding = false;
    holdPlateau = false;
    ribbon?.clear();
    resetAfterBlit();
    liveSmoothCache = null;
    liveSmoothScene.length = 0;
    return {
      bakeMs,
      bake,
      points: points.map(cloneDot),
      blotTipGrow: state.grow,
      blotHalts: state.halts,
      undoPatch,
    };
  };

  return {
    attach(el) {
      if (host === el && ribbon) {
        syncSize();
        return backend;
      }
      host = el;
      peer = peerFactory(el);
      const w = Math.max(1, el.width || 1);
      const h = Math.max(1, el.height || 1);
      const prefix = peer(w, h);
      ribbon = prefix ? createLiveRibbon(prefix) : null;
      snap = peer(w, h);
      return backend;
    },
    setPen(next) {
      pen = next;
    },
    down(s) {
      resetLive();
      drawing = true;
      ingestBatch([s]);
    },
    move(batch) {
      if (!drawing) return;
      ingestBatch(batch);
    },
    clipLiveToChord,
    pointCount() {
      return spine.length;
    },
    up(s) {
      const state = beginLift(s);
      const t0 = performance.now();
      const baked = bakeSpine(state.raw, {
        clothoid: state.options.clothoid,
        smoothing: state.options.smoothing,
      });
      const points = state.options.capillary ? capillaryRelax(baked.points) : baked.points;
      const bakeMs = performance.now() - t0;
      return finishLift(state, points, baked.bake, bakeMs, true, true);
    },
    liftRaw(s) {
      const state = beginLift(s);
      // Drain input that arrived after the last rAF before deriving the lift
      // preview: reshapeLiveSpine extends the shared frozen-prefix cache.
      if (drawing && paintedSegs !== segs) {
        composite();
        paintedSegs = segs;
      }
      const t0 = performance.now();
      // Keep the live-smoothed mesh already on the host. bakeSpine here would
      // sparsify the overlay into polygon vertices after lift.
      const preview =
        pen?.smoothingMode === "live" && state.options.smoothing > 0 && state.raw.length >= 3
          ? reshapeLiveSpine(
              state.raw,
              state.options.smoothing,
              liveSmoothCache,
              liveSmoothScene,
            ).points
          : state.raw;
      // Keep the pre-blit snap patch. `false` here left every pen stroke
      // with a null undo slot, so Ctrl+Z remeshed the whole notebook.
      const result = finishLift(
        state,
        preview,
        "catmull",
        performance.now() - t0,
        true,
        true,
      );
      return { ...result, bakeInput: state.raw, bakeOptions: state.options };
    },
    paint() {
      const t0 = performance.now();
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
    redrawSnapRegion(box, paint) {
      if (drawing || !host || !snap) return;
      const sctx = snap.getContext("2d");
      const ctx = host.getContext("2d");
      if (!sctx || !ctx) return;
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.beginPath();
      sctx.rect(box.x, box.y, box.w, box.h);
      sctx.clip();
      sctx.clearRect(box.x, box.y, box.w, box.h);
      paint(sctx);
      sctx.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      presentHost(ctx, box, snap);
      ctx.restore();
    },
    replaySpines(strokes) {
      blitClip = null;
      blitSpinesOntoSnap(strokes, true);
    },
    appendSpines(strokes, clips) {
      blitClip = clips && clips.length > 0 ? clips : null;
      blitSpinesOntoSnap(strokes, false);
      blitClip = null;
    },
    shiftSnap,
    copySnapPatch,
    restoreSnapPatch,
    replaceLastStroke(patch, points) {
      if (drawing || !host || !snap) return null;
      restoreSnapPatch(patch);
      applyBaked(points);
      unionAabb(aabb, { minX: patch.x, minY: patch.y,
        maxX: patch.x + patch.w, maxY: patch.y + patch.h });
      const undo = copySnapPatch(aabb);
      blitLiveToSnap();
      const ctx = host.getContext("2d");
      const clip = clipBlitRect(aabb, host.width, host.height, CLIP_BLIT_PAD);
      if (ctx && clip) presentHost(ctx, clip, snap);
      resetAfterBlit();
      return undo;
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
      ribbon = null;
      snap = null;
      host = null;
      peer = null;
      pen = null;
    },
  };
}
