/**
 * One in-progress ink gesture.
 *
 * RasterInkLayer owns capture, the overlay, the stroke-start snapshot, and rAF.
 * This session owns ingest, attack/dwell/stamp, reshape, and live overlay paint.
 * Ingest writes a preallocated ring; tick drains it. Dense hops stay off the
 * spine and ride a transient tip. Speed Ink stamps round canvas strokes live
 * and remeshes once on lift. Other pens still plant a Catmull on a turning hop.
 *
 * Stamp-live (`speedStampLive`) is no longer the default whiteboard live path.
 * RasterInkLayer paints the default pen through `canvas/inkLab`. This session
 * still owns capture, highlighter, eraser, and lift commit into InkOp / tiles.
 * Do not delete the ribbon until committed paint uses the lab bake as well.
 */

import { overdrawnViewport } from "./panOffset";
import { DEBUG_INK, inkMetrics, type InkPathTag } from "./inkMetrics";
import {
  blotGrowTFromTicks,
  blotTicksToFull,
  eraserSceneRadius,
  hasStylusPressure,
  HIGHLIGHT_WIDTH_SCALE,
  inkBaseWidthForZoom,
  inkLineWidth,
  inkSlowness,
  inkStrokeStyle,
  INK_ATTACK_MS,
  INK_HOLD_STILL_PX,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  isDiscPrimaryPath,
  isHostBoundOp,
  liveInkBlotGrow,
  NO_PRESSURE,
  scenePointFromPointer,
  smoothPressure,
  smoothSpeed,
  stampInkBlotHalt,
  highlightLiftKeepsTip,
  liveRibbonDirtySpine,
  prepareLiveRibbon,
  curveAlongHop,
  expandInkTurns,
  setInkSceneTransform,
  paintSplineInk,
  usesSplineOutline,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ScenePoint,
  type ScrollHostLookup,
  type ViewportTransform,
  releaseLiveRibbonBuffers,
} from "./rasterInk";
import { paintLiveOp, strokeAabb } from "./inkTiles";
import {
  smoothLiveInkPoints,
  type InkSmoothingMode,
  type LiveSmoothCache,
} from "./inkSmoothing";
import { straightenFromAnchor } from "./straightAnchor";

const RING_START = 1024;
/** Tip-cluster floor — extra coincident hold samples do not make a rounder disc. */
const HOLD_DISC_SAMPLES = 4;
/** Live Speed Ink eases toward the pace width so a flick does not hairline. */
const STAMP_WIDTH_EASE = 0.45;

/**
 * Running disc-vs-ribbon decision for the live trail.
 *
 * Matches {@link isDiscPrimaryPath} without cloning `[...points, candidate]`.
 * Once the path leaves disc-primary, that decision sticks.
 */
export class DiscExtentTracker {
  private stickyRibbon = false;
  private n = 0;
  private pathLen = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private lastX = 0;
  private lastY = 0;

  reset(origin: ScenePoint): void {
    this.stickyRibbon = false;
    this.n = 1;
    this.pathLen = 0;
    this.minX = this.maxX = origin.x;
    this.minY = this.maxY = origin.y;
    this.lastX = origin.x;
    this.lastY = origin.y;
  }

  wouldStayDisc(candidate: ScenePoint, nib: number): boolean {
    if (this.stickyRibbon) return false;
    const stay = this.previewStay(candidate, nib);
    if (!stay) this.stickyRibbon = true;
    return stay;
  }

  commit(point: ScenePoint): void {
    if (this.n >= 1) {
      this.pathLen += Math.hypot(point.x - this.lastX, point.y - this.lastY);
    }
    if (this.n === 0) {
      this.minX = this.maxX = point.x;
      this.minY = this.maxY = point.y;
    } else {
      if (point.x < this.minX) this.minX = point.x;
      if (point.x > this.maxX) this.maxX = point.x;
      if (point.y < this.minY) this.minY = point.y;
      if (point.y > this.maxY) this.maxY = point.y;
    }
    this.lastX = point.x;
    this.lastY = point.y;
    this.n += 1;
  }

  private previewStay(candidate: ScenePoint, nib: number): boolean {
    const nextN = this.n + 1;
    if (nextN <= 1) return true;
    const nextLen =
      this.pathLen + Math.hypot(candidate.x - this.lastX, candidate.y - this.lastY);
    const minX = Math.min(this.minX, candidate.x);
    const maxX = Math.max(this.maxX, candidate.x);
    const minY = Math.min(this.minY, candidate.y);
    const maxY = Math.max(this.maxY, candidate.y);
    const extent = Math.hypot(maxX - minX, maxY - minY);
    if (nextN === 2) {
      if (nextLen < 1e-3) return true;
      if (nextLen < nib * 0.25) return true;
      return extent < nib;
    }
    if (nextLen < 1e-3) return true;
    return extent < nib;
  }
}

const SPINE_START = 64;

/**
 * Live spine as typed arrays. Tessellation still reads {@link ScenePoint}
 * objects, but those are a reused view — grow-by-doubling, no per-frame
 * `points` array. {@link SpineTape.materialize} runs at commit.
 */
class SpineTape {
  private x = new Float64Array(SPINE_START);
  private y = new Float64Array(SPINE_START);
  private p = new Float32Array(SPINE_START);
  private s = new Float32Array(SPINE_START);
  n = 0;
  readonly view: ScenePoint[] = [];

  private ensure(need: number): void {
    if (need <= this.x.length) return;
    let cap = this.x.length;
    while (cap < need) cap *= 2;
    const nx = new Float64Array(cap);
    const ny = new Float64Array(cap);
    const np = new Float32Array(cap);
    const ns = new Float32Array(cap);
    nx.set(this.x.subarray(0, this.n));
    ny.set(this.y.subarray(0, this.n));
    np.set(this.p.subarray(0, this.n));
    ns.set(this.s.subarray(0, this.n));
    this.x = nx;
    this.y = ny;
    this.p = np;
    this.s = ns;
  }

  private write(i: number, pt: ScenePoint): void {
    this.x[i] = pt.x;
    this.y[i] = pt.y;
    this.p[i] = pt.pressure;
    this.s[i] = pt.slowness === undefined ? Number.NaN : pt.slowness;
    let slot = this.view[i];
    if (!slot) {
      slot = { x: pt.x, y: pt.y, pressure: pt.pressure };
      this.view[i] = slot;
    } else {
      slot.x = pt.x;
      slot.y = pt.y;
      slot.pressure = pt.pressure;
    }
    if (pt.slowness === undefined) delete slot.slowness;
    else slot.slowness = pt.slowness;
  }

  push(pt: ScenePoint): ScenePoint {
    this.ensure(this.n + 1);
    this.write(this.n, pt);
    this.n += 1;
    this.view.length = this.n;
    return this.view[this.n - 1]!;
  }

  pop(): void {
    if (this.n === 0) return;
    this.n -= 1;
    this.view.length = this.n;
  }

  setAt(i: number, pt: ScenePoint): ScenePoint {
    this.write(i, pt);
    return this.view[i]!;
  }

  replace(pts: readonly ScenePoint[]): void {
    this.ensure(pts.length);
    this.n = pts.length;
    for (let i = 0; i < pts.length; i++) this.write(i, pts[i]!);
    this.view.length = this.n;
  }

  setPressure(i: number, pressure: number): void {
    this.p[i] = pressure;
    const slot = this.view[i];
    if (slot) slot.pressure = pressure;
  }

  setSlowness(i: number, slowness: number): void {
    this.s[i] = slowness;
    const slot = this.view[i];
    if (slot) slot.slowness = slowness;
  }

  asPoints(): ScenePoint[] {
    this.view.length = this.n;
    return this.view;
  }

  materialize(): ScenePoint[] {
    const out: ScenePoint[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const sl = this.s[i]!;
      out[i] =
        sl === sl
          ? { x: this.x[i]!, y: this.y[i]!, pressure: this.p[i]!, slowness: sl }
          : { x: this.x[i]!, y: this.y[i]!, pressure: this.p[i]! };
    }
    return out;
  }

  captureView(): void {
    for (let i = 0; i < this.n; i++) {
      const pt = this.view[i];
      if (!pt) continue;
      this.x[i] = pt.x;
      this.y[i] = pt.y;
      this.p[i] = pt.pressure;
      this.s[i] = pt.slowness === undefined ? Number.NaN : pt.slowness;
    }
  }
}

export type LivePaintResult = "ok" | "fallback";

export type PixelRect = { x: number; y: number; w: number; h: number };

function unionPixelRects(a: PixelRect, b: PixelRect | null): PixelRect {
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface LivePointerSample {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
  pointerType: string;
}

export type LiveStrokeTool = "pen" | "highlighter" | "eraser";

export interface LiveStrokeBox {
  width: number;
  height: number;
  marginY: number;
}

export interface BeginLiveStroke {
  tool: LiveStrokeTool;
  view: ViewportTransform;
  rect: DOMRectReadOnly;
  box: LiveStrokeBox;
  first: LivePointerSample;
  color: string;
  uiWidth: number;
  inkFullness: number;
  pressureClip: number;
  pressureSensitive: boolean;
  speedInk: number;
  speedBlotBlend: number;
  speedFade: number;
  grain: number;
  boldness: number;
  splineOutline?: boolean;
  splineGradient?: boolean;
  smoothing: number;
  smoothingMode: InkSmoothingMode;
  /** Shift/toggle chord; re-read each drained sample. Returns an index or null. */
  getStraightAnchor: () => number | null;
  host: { key: number; scrollLeft: number } | null;
  onNeedPaint: () => void;
}

export function beginLiveStroke(init: BeginLiveStroke): LiveStroke {
  return new LiveStroke(init);
}

export class LiveStroke {
  readonly view: ViewportTransform;
  readonly box: LiveStrokeBox;
  lastEventTimeMs = 0;
  straightTouched = false;

  private op: InkOp;
  private readonly rect: DOMRectReadOnly;
  private readonly boldness: number;
  private readonly smoothing: number;
  private readonly smoothingMode: InkSmoothingMode;
  private readonly getStraightAnchor: () => number | null;
  private readonly onNeedPaint: () => void;
  private readonly pointerType: string;
  private ringX = new Float64Array(RING_START);
  private ringY = new Float64Array(RING_START);
  private ringP = new Float64Array(RING_START);
  private ringT = new Float64Array(RING_START);
  private ringN = 0;
  private ingested = 0;
  private lastPoint: ScenePoint | null = null;
  private rawPoint: ScenePoint | null = null;
  private liveRaw: ScenePoint[] | null = null;
  private smoothCache: LiveSmoothCache | null = null;
  private smoothedPressure = 0;
  private smoothedSpeed = 0;
  private lastSampleTime = 0;
  private lastMoveWall = 0;
  private lastDwellTickWall = 0;
  private dwellCount = 0;
  private dwellTimer: ReturnType<typeof setInterval> | null = null;
  private attackBuffer: ScenePoint[] | null = null;
  private attackPeak = 0;
  private attackStart = 0;
  private attackCount = 0;
  private lastPaintFallback = false;
  private closed = false;
  private readonly disc = new DiscExtentTracker();
  private readonly spine = new SpineTape();
  private hasTransientTip = false;
  /** Spine samples added by the last {@link appendSpine} hop (always includes `to`). */
  private lastHopSpine = 1;
  private prevOverlayDirty: PixelRect | null = null;
  /** Head halt is stamped once, when the path leaves the contact disc. */
  private headPoolCommitted = false;
  private trail: HTMLCanvasElement | OffscreenCanvas | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private trailStamped = 0;
  private stampWidth = 0;
  lastLiveDirty: { dirtyFrom: number; suffixHit: boolean } | null = null;

  constructor(init: BeginLiveStroke) {
    this.view = init.view;
    this.box = init.box;
    this.rect = init.rect;
    this.boldness = init.boldness;
    this.smoothing = init.smoothing;
    this.smoothingMode = init.smoothingMode;
    this.getStraightAnchor = init.getStraightAnchor;
    this.onNeedPaint = init.onNeedPaint;
    this.pointerType = init.first.pointerType;
    this.lastEventTimeMs = init.first.timeStamp;
    this.lastSampleTime = init.first.timeStamp;
    this.lastMoveWall = performance.now();
    releaseLiveRibbonBuffers();

    const point = scenePointFromPointer(
      init.first.clientX,
      init.first.clientY,
      this.rect,
      init.view,
      init.first.pressure,
      init.first.pointerType,
    );
    const speed = init.speedInk;
    const blotBlend = init.speedBlotBlend;
    const fade = init.speedFade;
    if (speed > 0 || blotBlend > 0 || fade > 0) point.slowness = INK_SLOWNESS_NEUTRAL;
    this.lastPoint = point;
    this.rawPoint = point;
    this.disc.reset(point);
    this.spine.replace([point]);
    this.smoothedPressure = hasStylusPressure(point.pressure) ? point.pressure : 0;
    this.smoothedSpeed =
      speed > 0 || blotBlend > 0 || fade > 0 ? INK_SPEED_NEUTRAL_PX_MS : 0;
    this.ingested = 1;

    const penWidth = inkBaseWidthForZoom(init.uiWidth, init.view.zoom);
    const reshape = this.reshapeActive();
    const attackApplies =
      init.tool === "pen" &&
      init.pressureSensitive &&
      hasStylusPressure(point.pressure);

    if (init.tool === "highlighter") {
      this.op = {
        kind: "draw",
        color: init.color,
        baseWidth: penWidth,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        highlight: true,
        points: this.spine.asPoints(),
      };
      this.liveRaw = reshape ? [point] : null;
    } else if (init.tool === "pen") {
      this.op = {
        kind: "draw",
        color: init.color,
        baseWidth: penWidth,
        maxFullness: init.pressureSensitive
          ? Math.min(init.inkFullness, 0.999)
          : 1,
        pressureClip: init.pressureClip,
        pressureSensitive: init.pressureSensitive,
        speedInk: speed,
        ...(speed > 0 || blotBlend > 0 || fade > 0
          ? { speedBlotBlend: blotBlend, speedFade: fade }
          : {}),
        ...(init.grain > 0 ? { grain: init.grain } : {}),
        boldness: init.boldness,
        ...(init.splineOutline || init.splineGradient
          ? {
              splineOutline: true,
              ...(init.splineGradient ? { splineGradient: true } : {}),
            }
          : {}),
        points: this.spine.asPoints(),
      };
      if (attackApplies) {
        this.attackBuffer = [point];
        this.attackPeak = point.pressure;
        this.attackStart = init.first.timeStamp;
        this.attackCount = 1;
      }
      this.liveRaw = reshape ? [point] : null;
    } else {
      this.op = {
        kind: "erase",
        radius: eraserSceneRadius(init.uiWidth),
        points: this.spine.asPoints(),
      };
      this.liveRaw = null;
    }
    this.bindHost(init.host);

    if (
      init.tool === "pen" &&
      (speed > 0 || fade > 0 || blotBlend > 0) &&
      !init.splineOutline &&
      !init.splineGradient
    ) {
      this.startDwell();
    }
  }

  get live(): InkOp | null {
    return this.closed ? null : this.op;
  }

  /** Pointer samples waiting on the ring, before {@link tick} drains them. */
  queuedSamples(): number {
    return this.ringN;
  }

  get fallback(): boolean {
    return this.lastPaintFallback || isHostBoundOp(this.op);
  }

  /** Round canvas stamps live; the Speed Ink ribbon waits for lift. */
  speedStampLive(): boolean {
    const live = this.op;
    return (
      live.kind === "draw" &&
      live.highlight !== true &&
      (live.speedInk ?? 0) > 0 &&
      !this.reshapeActive() &&
      !this.splineOutlineLive()
    );
  }

  /** Perfect-freehand outline fill live. The ribbon and stamp paths stay off. */
  splineOutlineLive(): boolean {
    const live = this.op;
    return live.kind === "draw" && usesSplineOutline(live) && !this.reshapeActive();
  }

  ingest(batch: readonly LivePointerSample[]): void {
    if (this.closed || batch.length === 0) return;
    this.ensureRing(batch.length);
    for (const sample of batch) {
      const i = this.ringN;
      this.ringX[i] = sample.clientX;
      this.ringY[i] = sample.clientY;
      this.ringP[i] = sample.pressure;
      this.ringT[i] = sample.timeStamp;
      this.ringN += 1;
    }
    this.lastEventTimeMs = batch[batch.length - 1]!.timeStamp;
    this.ingested += batch.length;
  }

  tick(nowMs: number): boolean {
    if (this.closed) return false;
    let dirty = false;
    const n = this.ringN;
    if (n > 0) {
      this.drainRing(n);
      this.ringN = 0;
      dirty = true;
    }
    const dwell = this.tickDwell(nowMs);
    if (dwell.dirty) dirty = true;
    if (dwell.settled) this.stopDwell();
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.live({
        ringSamples: this.ingested,
        spineN: this.spineCount(),
        transientTip: this.hasTransientTip,
        dirtyFrom: 0,
      });
    }
    return dirty;
  }

  paint(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    dpr: number,
    clip: SceneBounds | null,
    hosts: ScrollHostLookup,
    snap: HTMLCanvasElement | null,
    full = false,
  ): LivePaintResult {
    if (this.closed) return "fallback";
    this.bindHostOnOp();
    if (this.reshapeLive()) {
      this.markPath("reshape");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      this.lastLiveDirty = null;
      return "fallback";
    }
    if (isHostBoundOp(this.op)) {
      this.markPath("hostBound");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      this.lastLiveDirty = null;
      return "fallback";
    }
    if (
      canvas.width !== Math.round(this.box.width * dpr) ||
      canvas.height !== Math.round(this.box.height * dpr)
    ) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      this.lastLiveDirty = null;
      return "fallback";
    }
    if (!snap || snap.width !== canvas.width || snap.height !== canvas.height) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      this.lastLiveDirty = null;
      return "fallback";
    }

    const marginY = this.box.marginY;
    const baseView: ViewportTransform = {
      ...this.view,
      scrollY: this.view.scrollY - marginY / this.view.zoom,
      height: this.view.height - 2 * marginY,
    };
    const drawView = overdrawnViewport(baseView, marginY);
    if (this.splineOutlineLive()) {
      return this.paintSplineOutline(ctx, canvas, dpr, clip, snap, drawView, full);
    }
    if (this.speedStampLive()) {
      return this.paintSpeedStamp(ctx, canvas, dpr, clip, snap, drawView, full);
    }
    if (this.op.kind === "draw") {
      prepareLiveRibbon(this.op, drawView.zoom * dpr);
    }
    const local = this.overlayLocalPx(drawView, dpr);
    const dirty = unionPixelRects(local, this.prevOverlayDirty);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.drawImage(
      snap,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.clip();
    paintLiveOp(ctx, this.op, drawView, dpr, clip, hosts);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = prevSmooth;
    this.prevOverlayDirty = local;
    this.lastLiveDirty = liveRibbonDirtySpine();
    this.markPath("incremental");
    this.lastPaintFallback = false;
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.overlay(canvas.width, canvas.height, dpr);
    }
    return "ok";
  }

  commit(): InkOp {
    this.tick(performance.now());
    this.settleTip();
    this.stopDwell();
    this.prevOverlayDirty = null;
    this.spine.captureView();
    this.op.points = this.spine.materialize();
    if (this.speedStampLive() && this.op.kind === "draw") {
      this.op.points = expandInkTurns(this.op.points);
    }
    this.dropSpeedTrail();
    releaseLiveRibbonBuffers();
    return this.op;
  }

  abandon(): void {
    this.closed = true;
    this.stopDwell();
    this.ringN = 0;
    this.attackBuffer = null;
    this.liveRaw = null;
    this.lastPoint = null;
    this.rawPoint = null;
    this.hasTransientTip = false;
    this.prevOverlayDirty = null;
    this.lastLiveDirty = null;
    this.dropSpeedTrail();
    releaseLiveRibbonBuffers();
  }

  overlayDirtyPx(prev: PixelRect | null, view: ViewportTransform, dpr: number): PixelRect {
    return unionPixelRects(this.overlayLocalPx(view, dpr), prev);
  }

  private overlayLocalPx(view: ViewportTransform, dpr: number): PixelRect {
    const n = this.op.kind === "draw" ? this.op.points.length : 0;
    const hop = Math.max(2, this.lastHopSpine + 1);
    let from = 0;
    if (this.splineOutlineLive()) {
      from = 0;
    } else if (this.speedStampLive()) {
      from = Math.max(0, n - hop);
    } else {
      const liveDirty = this.op.kind === "draw" ? liveRibbonDirtySpine() : null;
      // Suffix-hit: only the last hop (join + seeds). A turning hop can plant
      // many samples; n-2 would be the last 2px, not the hop. Prefix remesh
      // (dirtyFrom 0) keeps the full AABB.
      const rawFrom = !liveDirty
        ? 0
        : liveDirty.suffixHit
          ? Math.max(0, n - hop)
          : liveDirty.dirtyFrom;
      from = Math.max(0, Math.min(rawFrom, n));
    }
    const aabb = strokeAabb(this.op, from);
    const z = view.zoom * dpr;
    const pad = 2;
    let x0 = Math.floor((aabb.minX + view.scrollX) * z) - pad;
    let y0 = Math.floor((aabb.minY + view.scrollY) * z) - pad;
    let x1 = Math.ceil((aabb.maxX + view.scrollX) * z) + pad;
    let y1 = Math.ceil((aabb.maxY + view.scrollY) * z) + pad;
    const maxW = Math.max(1, Math.round(this.box.width * dpr));
    const maxH = Math.max(1, Math.round(this.box.height * dpr));
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(maxW, x1);
    y1 = Math.min(maxH, y1);
    if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: maxW, h: maxH };
    const w = x1 - x0;
    const h = y1 - y0;
    if (w * h > maxW * maxH * 0.7) return { x: 0, y: 0, w: maxW, h: maxH };
    return { x: x0, y: y0, w, h };
  }

  private paintSpeedStamp(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    dpr: number,
    clip: SceneBounds | null,
    snap: HTMLCanvasElement,
    drawView: ViewportTransform,
    full: boolean,
  ): LivePaintResult {
    if (!this.ensureSpeedTrail(snap)) return "fallback";
    this.stampPendingOntoTrail(drawView, dpr);
    const local = this.overlayLocalPx(drawView, dpr);
    const dirty = full
      ? { x: 0, y: 0, w: canvas.width, h: canvas.height }
      : unionPixelRects(local, this.prevOverlayDirty);
    const trail = this.trail!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.drawImage(
      trail as CanvasImageSource,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.clip();
    this.paintSpeedTip(ctx, drawView, dpr, clip);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = prevSmooth;
    this.prevOverlayDirty = full ? null : local;
    const n = this.op.kind === "draw" ? this.op.points.length : 0;
    this.lastLiveDirty = { dirtyFrom: Math.max(0, n - this.lastHopSpine), suffixHit: true };
    this.markPath("incremental");
    this.lastPaintFallback = false;
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.overlay(canvas.width, canvas.height, dpr);
    }
    return "ok";
  }

  private paintSplineOutline(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    dpr: number,
    clip: SceneBounds | null,
    snap: HTMLCanvasElement,
    drawView: ViewportTransform,
    full: boolean,
  ): LivePaintResult {
    if (this.op.kind !== "draw") return "fallback";
    const local = this.overlayLocalPx(drawView, dpr);
    const dirty = full
      ? { x: 0, y: 0, w: canvas.width, h: canvas.height }
      : unionPixelRects(local, this.prevOverlayDirty);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.drawImage(
      snap,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
    ctx.clip();
    setInkSceneTransform(ctx, drawView, dpr);
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
      ctx.clip();
    }
    paintSplineInk(ctx, this.op, false);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = prevSmooth;
    this.prevOverlayDirty = full ? null : local;
    this.lastLiveDirty = { dirtyFrom: 0, suffixHit: false };
    this.markPath("incremental");
    this.lastPaintFallback = false;
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.overlay(canvas.width, canvas.height, dpr);
    }
    return "ok";
  }

  private ensureSpeedTrail(snap: HTMLCanvasElement): boolean {
    const w = snap.width;
    const h = snap.height;
    if (this.trail && this.trailCtx && this.trail.width === w && this.trail.height === h) {
      return true;
    }
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(w, h)
        : (() => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            return c;
          })();
    const tctx = canvas.getContext("2d");
    if (!tctx) return false;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, w, h);
    tctx.drawImage(snap, 0, 0);
    this.trail = canvas;
    this.trailCtx = tctx as CanvasRenderingContext2D;
    this.trailStamped = 0;
    this.stampWidth = 0;
    return true;
  }

  private dropSpeedTrail(): void {
    this.trail = null;
    this.trailCtx = null;
    this.trailStamped = 0;
    this.stampWidth = 0;
  }

  private stampPendingOntoTrail(drawView: ViewportTransform, dpr: number): void {
    const live = this.op;
    const tctx = this.trailCtx;
    if (live.kind !== "draw" || !tctx) return;
    const planted = this.spineCount();
    if (planted < 1) return;
    const pixelScale = drawView.zoom * dpr;
    tctx.save();
    setInkSceneTransform(tctx, drawView, dpr);
    tctx.lineCap = "round";
    tctx.lineJoin = "round";
    tctx.strokeStyle = live.color;
    tctx.fillStyle = live.color;
    if (this.trailStamped < 1) {
      this.strokeSpeedDot(tctx, live, live.points[0]!, pixelScale);
      this.trailStamped = 1;
    }
    for (let i = this.trailStamped; i < planted; i++) {
      const from = live.points[i - 1]!;
      const to = live.points[i]!;
      this.strokeSpeedHop(tctx, live, from, to, pixelScale);
    }
    this.trailStamped = planted;
    tctx.restore();
  }

  private paintSpeedTip(
    ctx: CanvasRenderingContext2D,
    drawView: ViewportTransform,
    dpr: number,
    clip: SceneBounds | null,
  ): void {
    const live = this.op;
    if (live.kind !== "draw") return;
    const points = live.points;
    if (points.length === 0) return;
    const pixelScale = drawView.zoom * dpr;
    ctx.save();
    setInkSceneTransform(ctx, drawView, dpr);
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
      ctx.clip();
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = live.color;
    ctx.fillStyle = live.color;
    const planted = this.spineCount();
    if (this.hasTransientTip && planted >= 1 && points.length > planted) {
      this.strokeSpeedHop(ctx, live, points[planted - 1]!, points[points.length - 1]!, pixelScale);
    }
    const grow = liveInkBlotGrow(live);
    const tip = points[points.length - 1]!;
    if (grow > 1e-3 || planted <= 1) {
      this.strokeSpeedDot(ctx, live, tip, pixelScale, grow);
    }
    ctx.restore();
  }

  private strokeSpeedHop(
    ctx: CanvasRenderingContext2D,
    live: InkDrawOp,
    from: ScenePoint,
    to: ScenePoint,
    pixelScale: number,
  ): void {
    const style = this.speedStampStyle(live, to);
    this.easeStampWidth(style.lineWidth);
    const width = this.paintedStampWidth(this.stampWidth, pixelScale);
    if (width < 1e-6) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, style.alpha * (style.dryGain ?? 1)));
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private strokeSpeedDot(
    ctx: CanvasRenderingContext2D,
    live: InkDrawOp,
    at: ScenePoint,
    pixelScale: number,
    grow = 0,
  ): void {
    const style = this.speedStampStyle(live, at);
    this.easeStampWidth(style.lineWidth);
    const radius = (this.paintedStampWidth(this.stampWidth, pixelScale) / 2) * (1 + Math.max(0, grow));
    if (radius < 1e-6) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, style.alpha * (style.dryGain ?? 1)));
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private speedStampStyle(live: InkDrawOp, point: ScenePoint) {
    return inkStrokeStyle(
      live.baseWidth,
      live.maxFullness,
      point.pressure,
      live.pressureClip,
      live.pressureSensitive,
      0,
      point.slowness ?? INK_SLOWNESS_NEUTRAL,
      live.speedInk ?? 0,
      false,
      live.boldness ?? this.boldness,
      live.speedFade ?? 0,
    );
  }

  private easeStampWidth(target: number): void {
    if (this.stampWidth <= 1e-6) this.stampWidth = target;
    else this.stampWidth += (target - this.stampWidth) * STAMP_WIDTH_EASE;
  }

  private paintedStampWidth(lineWidth: number, pixelScale: number): number {
    if (pixelScale <= 0) return lineWidth;
    return Math.max(lineWidth, 0.65 / pixelScale);
  }

  private reshapeActive(): boolean {
    return this.smoothingMode === "live" && this.smoothing > 0;
  }

  private markPath(tag: InkPathTag): void {
    if (DEBUG_INK || inkMetrics.enabled) inkMetrics.path(tag);
  }

  private bindHost(host: { key: number; scrollLeft: number } | null): void {
    if (!host) return;
    this.op.hostKey = host.key;
    this.op.scrollLeftAtDraw = host.scrollLeft;
  }

  private bindHostOnOp(): void {
    // Host is frozen at pointerdown; nothing to refresh besides keeping tags.
  }

  private spineCount(): number {
    const n = this.spine.n;
    return this.hasTransientTip ? Math.max(0, n - 1) : n;
  }

  private bindSpine(): void {
    this.op.points = this.spine.asPoints();
  }

  private ensureRing(more: number): void {
    const need = this.ringN + more;
    if (need <= this.ringX.length) return;
    let cap = this.ringX.length;
    while (cap < need) cap *= 2;
    const nx = new Float64Array(cap);
    const ny = new Float64Array(cap);
    const np = new Float64Array(cap);
    const nt = new Float64Array(cap);
    nx.set(this.ringX.subarray(0, this.ringN));
    ny.set(this.ringY.subarray(0, this.ringN));
    np.set(this.ringP.subarray(0, this.ringN));
    nt.set(this.ringT.subarray(0, this.ringN));
    this.ringX = nx;
    this.ringY = ny;
    this.ringP = np;
    this.ringT = nt;
  }

  private stampStep(point: ScenePoint): number {
    const live = this.op;
    if (live.kind === "erase") return Math.max(live.radius * 0.45, 0.5);
    const speedInk = live.speedInk ?? 0;
    const style = inkStrokeStyle(
      live.baseWidth,
      live.maxFullness,
      point.pressure,
      live.pressureClip,
      live.pressureSensitive,
      0,
      point.slowness ?? INK_SLOWNESS_NEUTRAL,
      speedInk,
      live.highlight === true,
      live.boldness ?? this.boldness,
      live.speedFade ?? 0,
    );
    const dense =
      speedInk > 0 ||
      (live.pressureSensitive && hasStylusPressure(point.pressure));
    return Math.max(
      style.lineWidth * (dense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
      0.5,
    );
  }

  private setTransientTip(tip: ScenePoint): void {
    if (this.hasTransientTip) {
      this.spine.setAt(this.spine.n - 1, tip);
    } else {
      this.spine.push(tip);
      this.hasTransientTip = true;
    }
    this.bindSpine();
  }

  private dropTransientTip(): void {
    if (!this.hasTransientTip) return;
    this.spine.pop();
    this.hasTransientTip = false;
    this.bindSpine();
  }

  private collapseToOrigin(origin: ScenePoint): void {
    this.dropTransientTip();
    this.spine.replace([origin]);
    this.bindSpine();
    this.disc.reset(origin);
    this.headPoolCommitted = false;
    this.lastPoint = this.spine.view[0] ?? origin;
    if (this.reshapeActive()) this.liveRaw = [origin];
    this.dropSpeedTrail();
  }

  private appendSpine(from: ScenePoint, to: ScenePoint, step: number): void {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < step) {
      this.setTransientTip(to);
      return;
    }
    this.dropTransientTip();
    if (this.speedStampLive() || this.splineOutlineLive()) {
      this.lastHopSpine = 1;
      this.spine.push(to);
      this.disc.commit(to);
      this.bindSpine();
      this.lastPoint = to;
      return;
    }
    const n = this.spine.n;
    const start = n >= 1 ? this.spine.view[n - 1]! : from;
    const prev = n >= 2 ? this.spine.view[n - 2]! : null;
    const seeds = curveAlongHop(prev, start, to, step);
    this.lastHopSpine = seeds.length;
    for (const seed of seeds) {
      this.spine.push(seed);
      this.disc.commit(seed);
    }
    this.bindSpine();
    this.lastPoint = this.spine.view[this.spine.n - 1] ?? from;
  }

  private appendRaw(to: ScenePoint): void {
    const rawBuf = this.liveRaw ?? (this.liveRaw = []);
    rawBuf.push(to);
  }

  private drainRing(n: number): void {
    const live = this.op;
    const zoom = this.view.zoom || 1;
    const pressureSensitive = live.kind === "draw" && live.pressureSensitive;
    const speedInk = live.kind === "draw" ? (live.speedInk ?? 0) : 0;
    const speedFade = live.kind === "draw" ? (live.speedFade ?? 0) : 0;
    const speedBlot = live.kind === "draw" ? (live.speedBlotBlend ?? 0) : 0;
    const trackPace =
      speedInk > 0 ||
      speedFade > 0 ||
      speedBlot > 0 ||
      (live.kind === "draw" && live.splineGradient === true);
    const reshapeLive = live.kind === "draw" && this.reshapeActive();
    const nib =
      live.kind === "draw"
        ? Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6)
        : 0;

    for (let i = 0; i < n; i++) {
      const rawLast = this.rawPoint;
      if (!rawLast) break;
      const raw = scenePointFromPointer(
        this.ringX[i]!,
        this.ringY[i]!,
        this.rect,
        this.view,
        this.ringP[i]!,
        this.pointerType,
      );
      const dt = this.ringT[i]! - this.lastSampleTime;
      this.lastSampleTime = this.ringT[i]!;
      this.noteInkTravel(raw.x - rawLast.x, raw.y - rawLast.y, zoom, live);

      if (pressureSensitive && hasStylusPressure(raw.pressure)) {
        if (this.attackBuffer && raw.pressure > this.attackPeak) {
          this.attackPeak = raw.pressure;
        }
        this.smoothedPressure = smoothPressure(this.smoothedPressure, raw.pressure);
        raw.pressure = this.smoothedPressure;
      } else {
        raw.pressure = NO_PRESSURE;
      }

      if (trackPace) {
        const travelled = Math.hypot(raw.x - rawLast.x, raw.y - rawLast.y) * zoom;
        if (dt > 0) {
          this.smoothedSpeed = smoothSpeed(this.smoothedSpeed, travelled / dt);
        }
        raw.slowness = inkSlowness(this.smoothedSpeed);
      }
      this.rawPoint = raw;

      if (this.attackBuffer && live.kind === "draw") {
        this.attackBuffer.push(raw);
        this.attackCount += 1;
        continue;
      }

      this.stampSample(raw, reshapeLive, nib);
    }

    if (this.attackBuffer && live.kind === "draw") {
      if (this.spine.n > 0 && hasStylusPressure(this.attackPeak)) {
        this.spine.setPressure(0, this.attackPeak);
      }
      const lastT = n > 0 ? this.ringT[n - 1]! : this.attackStart;
      const shouldFlush =
        lastT - this.attackStart >= INK_ATTACK_MS || this.attackCount >= 3;
      if (shouldFlush) this.flushAttackBuffer();
    }
  }

  private stampSample(point: ScenePoint, reshapeLive: boolean, nib: number): void {
    const live = this.op;
    const last = this.lastPoint;
    if (!last) return;

    const anchor = this.getStraightAnchor();
    if (live.kind === "draw" && anchor != null) {
      this.straightTouched = true;
      this.dropTransientTip();
      this.spine.replace(straightenFromAnchor(this.spine.asPoints(), anchor, point));
      this.bindSpine();
      if (reshapeLive) this.liveRaw = [...this.op.points];
      this.lastPoint = point;
      this.disc.reset(this.op.points[0]!);
      for (let i = 1; i < this.spine.n; i++) this.disc.commit(this.op.points[i]!);
      this.dropSpeedTrail();
      return;
    }

    if (live.kind === "draw" && live.highlight !== true && live.points[0]) {
      if (this.disc.wouldStayDisc(point, nib)) {
        const origin = live.points[0];
        if (
          hasStylusPressure(point.pressure) &&
          point.pressure > origin.pressure
        ) {
          origin.pressure = point.pressure;
        }
        if (point.slowness !== undefined) {
          // Speed ink reads slowness as width. A wiggle inside the disc is
          // still the hold; copying a faster sample onto the origin collapsed
          // the pool to the flick floor in one frame.
          origin.slowness =
            origin.slowness === undefined
              ? point.slowness
              : Math.max(origin.slowness, point.slowness);
        }
        this.collapseToOrigin(origin);
        return;
      }
      this.commitHeadPool(live);
    }

    if (live.kind === "draw" && live.highlight === true) {
      const chisel =
        inkLineWidth(live.baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE;
      if (!highlightLiftKeepsTip(live.points, point, chisel)) return;
    }

    const step = this.stampStep(point);
    if (reshapeLive) {
      this.appendRaw(point);
      this.lastPoint = point;
      return;
    }
    this.appendSpine(last, point, step);
  }

  private flushAttackBuffer(): void {
    const buf = this.attackBuffer;
    const live = this.op;
    if (!buf || live.kind !== "draw") return;
    const peak = this.attackPeak;
    for (const p of buf) {
      if (hasStylusPressure(p.pressure)) p.pressure = peak;
    }
    this.smoothedPressure = peak;
    this.attackBuffer = null;

    const origin = buf[0];
    this.rawPoint = buf[buf.length - 1] ?? origin;
    const nib = Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6);
    if (isDiscPrimaryPath(buf, nib)) {
      this.collapseToOrigin(origin);
      return;
    }

    this.commitHeadPool(live);
    this.dropTransientTip();
    this.spine.replace([origin]);
    this.bindSpine();
    this.disc.reset(origin);
    this.lastPoint = this.spine.view[0] ?? origin;
    for (let i = 1; i < buf.length; i++) {
      const point = buf[i]!;
      if (this.disc.wouldStayDisc(point, nib)) continue;
      this.appendSpine(this.lastPoint ?? origin, point, this.stampStep(point));
    }
    if (this.reshapeActive()) {
      this.liveRaw = live.points.slice();
    } else {
      this.liveRaw = null;
    }
  }

  private settleTip(): void {
    if (this.reshapeActive()) return;
    const live = this.op;
    const last = this.lastPoint;
    const raw = this.rawPoint;
    if (live.kind !== "draw" || !last || !raw) return;
    if (this.hasTransientTip) {
      this.lastPoint = raw;
      this.hasTransientTip = false;
      this.disc.commit(raw);
      return;
    }
    if (Math.hypot(raw.x - last.x, raw.y - last.y) < 1e-3) return;
    this.appendSpine(last, raw, this.stampStep(raw));
    if (this.hasTransientTip) {
      this.hasTransientTip = false;
      this.disc.commit(raw);
    }
    this.lastPoint = this.op.points[this.op.points.length - 1] ?? raw;
  }

  private tickDwell(nowMs: number): { dirty: boolean; settled: boolean } {
    const idle = { dirty: false, settled: false };
    if (this.attackBuffer) return idle;
    const live = this.op;
    if (live.kind !== "draw") return { dirty: false, settled: true };
    const blotBlend = live.speedBlotBlend ?? 0;
    const paceOn =
      (live.speedInk ?? 0) > 0 || blotBlend > 0 || (live.speedFade ?? 0) > 0;
    if (!paceOn) return { dirty: false, settled: true };
    if (live.points.length === 0) return idle;
    if (nowMs - this.lastMoveWall < 60) return idle;
    if (nowMs - this.lastDwellTickWall < 32 && this.lastDwellTickWall > 0) {
      return idle;
    }
    this.lastDwellTickWall = nowMs;
    const full = blotTicksToFull(blotBlend);
    if (this.dwellCount >= full) return { dirty: false, settled: true };
    this.dwellCount += 1;
    const prevGrow = live.blotTipGrow ?? 0;
    const nextGrow = Math.max(prevGrow, blotGrowTFromTicks(this.dwellCount, blotBlend));
    live.blotTipGrow = nextGrow;
    this.smoothedSpeed = smoothSpeed(this.smoothedSpeed, 0);
    const last = this.lastPoint;
    if (!last) return { dirty: nextGrow - prevGrow > 1e-4, settled: this.dwellCount >= full };
    const slowness = inkSlowness(this.smoothedSpeed);
    const dwellPoint: ScenePoint = {
      ...last,
      slowness,
    };
    if (live.pressureSensitive && hasStylusPressure(last.pressure)) {
      dwellPoint.pressure = this.smoothedPressure;
    }
    const dwellNib = Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6);
    const lastIdx = this.spine.n - 1;
    let piled = false;
    if (this.disc.wouldStayDisc(dwellPoint, dwellNib)) {
      const prevSlow = this.spine.view[0]?.slowness ?? last.slowness ?? slowness;
      const hold =
        last.slowness === undefined ? slowness : Math.max(last.slowness, slowness);
      last.slowness = hold;
      if (this.spine.n > 0) {
        this.spine.setSlowness(0, hold);
        if (hasStylusPressure(dwellPoint.pressure)) {
          const contact = this.spine.view[0]!;
          this.spine.setPressure(0, Math.max(contact.pressure, dwellPoint.pressure));
        }
      }
      if (lastIdx > 0) this.spine.setSlowness(lastIdx, hold);
      const contact = this.spine.view[0];
      if (blotBlend > 1e-3 && contact && this.spine.n < HOLD_DISC_SAMPLES) {
        this.spine.push({
          x: contact.x,
          y: contact.y,
          pressure: contact.pressure,
          slowness: hold,
        });
        this.bindSpine();
        piled = true;
      }
      this.lastPoint = contact ?? last;
      const dirty =
        piled || nextGrow - prevGrow > 1e-4 || Math.abs(hold - prevSlow) > 1e-4;
      const settled = this.dwellCount >= full || (nextGrow >= 1 - 1e-3 && !dirty);
      return { dirty, settled };
    }
    const prevSlow = last.slowness ?? slowness;
    last.slowness = slowness;
    if (lastIdx >= 0) this.spine.setSlowness(lastIdx, slowness);
    if (lastIdx >= 0 && hasStylusPressure(dwellPoint.pressure)) {
      this.spine.setPressure(lastIdx, dwellPoint.pressure);
    }
    this.lastPoint = dwellPoint;
    const dirty =
      nextGrow - prevGrow > 1e-4 || Math.abs(slowness - prevSlow) > 1e-4;
    const settled = this.dwellCount >= full || (nextGrow >= 1 - 1e-3 && !dirty);
    return { dirty, settled };
  }

  private startDwell(): void {
    if (this.dwellTimer !== null || this.closed) return;
    this.dwellTimer = setInterval(() => {
      if (this.closed) return;
      if (this.tick(performance.now())) this.onNeedPaint();
    }, 32);
  }

  private noteInkTravel(dx: number, dy: number, zoom: number, live: InkOp): boolean {
    const px = Math.hypot(dx, dy) * zoom;
    if (px <= INK_HOLD_STILL_PX) return false;
    if (live.kind === "draw") {
      const grow = liveInkBlotGrow(live);
      if (grow > 1e-3) {
        const at = this.lastPoint ?? live.points[live.points.length - 1];
        const origin = live.points[0];
        const nib = inkLineWidth(live.baseWidth, 0, false);
        const nearHead =
          !this.headPoolCommitted &&
          !!at &&
          !!origin &&
          Math.hypot(at.x - origin.x, at.y - origin.y) < Math.max(0.75, nib * 0.5);
        if (at) {
          const haltAt = nearHead && origin ? { ...at, x: origin.x, y: origin.y } : at;
          stampInkBlotHalt(live, haltAt, grow);
        }
      }
    }
    this.lastMoveWall = performance.now();
    this.dwellCount = 0;
    this.startDwell();
    return true;
  }

  /**
   * Freeze the hold's last grow onto a halt and drop the live timer.
   *
   * Called only when the stroke leaves the contact disc. Zeroing `blotTipGrow`
   * while still disc-primary made the pool snap to the nib — the halt lives on
   * the ribbon, and the disc did not read it — so a wiggle inside one nib
   * cancelled the circle, then a later hop drew a new mark. The ribbon still
   * must not inherit that grow at the moving tip, so it is cleared here, after
   * the halt has the value.
   */
  private commitHeadPool(live: InkOp): void {
    if (live.kind !== "draw") return;
    if (this.headPoolCommitted) return;
    this.headPoolCommitted = true;
    const grow = liveInkBlotGrow(live);
    const origin = live.points[0];
    if (grow > 1e-3 && origin) stampInkBlotHalt(live, origin, grow);
    // Halt merge keeps the slower (fatter) pace. Put that back on the origin
    // so the ribbon starts at the hold width, not the first flick.
    const halt = live.blotHalts?.[live.blotHalts.length - 1];
    if (origin && halt?.slowness != null) {
      origin.slowness =
        origin.slowness == null ? halt.slowness : Math.max(origin.slowness, halt.slowness);
    }
    live.blotTipGrow = 0;
  }

  private reshapeLive(): boolean {
    const live = this.op;
    const raw = this.liveRaw;
    if (live.kind !== "draw" || !raw || !this.reshapeActive()) return false;
    const reshaped = smoothLiveInkPoints(
      raw,
      this.smoothing,
      inkLineWidth(live.baseWidth, 0, false),
      this.smoothCache,
    );
    this.spine.replace(reshaped.points);
    this.bindSpine();
    this.smoothCache = reshaped.cache;
    return true;
  }

  private stopDwell(): void {
    if (this.dwellTimer !== null) {
      clearInterval(this.dwellTimer);
      this.dwellTimer = null;
    }
  }
}
