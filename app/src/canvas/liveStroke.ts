/**
 * One in-progress ink gesture.
 *
 * RasterInkLayer owns capture, the overlay, the stroke-start snapshot, and rAF.
 * This session owns ingest, attack/dwell/stamp, reshape, and live overlay paint.
 * Ingest writes a preallocated ring; tick drains it. Dense hops stay off the
 * spine and ride a transient tip so tessellation does not grow with digitizer Hz.
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
  stampAlongSegment,
  stampInkBlotHalt,
  trimHighlightLiftHook,
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

export type LivePaintResult = "ok" | "fallback";

export type PixelRect = { x: number; y: number; w: number; h: number };

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
  private hasTransientTip = false;
  private prevOverlayDirty: PixelRect | null = null;

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
        points: [point],
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
        points: [point],
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
        points: [point],
      };
      this.liveRaw = null;
    }
    this.bindHost(init.host);

    if (init.tool === "pen" && (speed > 0 || fade > 0 || blotBlend > 0)) {
      this.dwellTimer = setInterval(() => {
        if (this.closed) return;
        this.tick(performance.now());
        this.onNeedPaint();
      }, 32);
    }
  }

  get live(): InkOp | null {
    return this.closed ? null : this.op;
  }

  get fallback(): boolean {
    return this.lastPaintFallback || isHostBoundOp(this.op);
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

  tick(nowMs: number): void {
    if (this.closed) return;
    const n = this.ringN;
    if (n > 0) {
      this.drainRing(n);
      this.ringN = 0;
    }
    this.tickDwell(nowMs);
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.live({
        ringSamples: this.ingested,
        spineN: this.spineCount(),
        transientTip: this.hasTransientTip,
        dirtyFrom: 0,
      });
    }
  }

  paint(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    dpr: number,
    clip: SceneBounds | null,
    hosts: ScrollHostLookup,
    snap: HTMLCanvasElement | null,
  ): LivePaintResult {
    if (this.closed) return "fallback";
    this.bindHostOnOp();
    if (this.reshapeLive()) {
      this.markPath("reshape");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      return "fallback";
    }
    if (isHostBoundOp(this.op)) {
      this.markPath("hostBound");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      return "fallback";
    }
    if (
      canvas.width !== Math.round(this.box.width * dpr) ||
      canvas.height !== Math.round(this.box.height * dpr)
    ) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      return "fallback";
    }
    if (!snap || snap.width !== canvas.width || snap.height !== canvas.height) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      this.prevOverlayDirty = null;
      return "fallback";
    }

    const marginY = this.box.marginY;
    const baseView: ViewportTransform = {
      ...this.view,
      scrollY: this.view.scrollY - marginY / this.view.zoom,
      height: this.view.height - 2 * marginY,
    };
    const drawView = overdrawnViewport(baseView, marginY);
    const dirty = this.overlayDirtyPx(this.prevOverlayDirty, drawView, dpr);
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
    this.prevOverlayDirty = dirty;
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
    releaseLiveRibbonBuffers();
  }

  overlayDirtyPx(prev: PixelRect | null, view: ViewportTransform, dpr: number): PixelRect {
    const aabb = strokeAabb(this.op);
    const z = view.zoom * dpr;
    const pad = 2;
    let x0 = Math.floor((aabb.minX + view.scrollX) * z) - pad;
    let y0 = Math.floor((aabb.minY + view.scrollY) * z) - pad;
    let x1 = Math.ceil((aabb.maxX + view.scrollX) * z) + pad;
    let y1 = Math.ceil((aabb.maxY + view.scrollY) * z) + pad;
    if (prev) {
      x0 = Math.min(x0, prev.x);
      y0 = Math.min(y0, prev.y);
      x1 = Math.max(x1, prev.x + prev.w);
      y1 = Math.max(y1, prev.y + prev.h);
    }
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
    const n = this.op.points.length;
    return this.hasTransientTip ? Math.max(0, n - 1) : n;
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
    const pts = this.op.points;
    if (this.hasTransientTip) {
      pts[pts.length - 1] = tip;
    } else {
      pts.push(tip);
      this.hasTransientTip = true;
    }
  }

  private dropTransientTip(): void {
    if (!this.hasTransientTip) return;
    this.op.points.pop();
    this.hasTransientTip = false;
  }

  private collapseToOrigin(origin: ScenePoint): void {
    this.dropTransientTip();
    this.op.points = [origin];
    this.disc.reset(origin);
    this.lastPoint = origin;
    if (this.reshapeActive()) this.liveRaw = [origin];
  }

  private appendSpine(from: ScenePoint, to: ScenePoint, step: number): void {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < step) {
      this.setTransientTip(to);
      return;
    }
    this.dropTransientTip();
    const stamps = stampAlongSegment(from, to, step);
    this.op.points.push(...stamps);
    for (const s of stamps) this.disc.commit(s);
    this.lastPoint = stamps[stamps.length - 1] ?? from;
  }

  private appendRaw(to: ScenePoint, step: number): void {
    const rawBuf = this.liveRaw ?? (this.liveRaw = []);
    const prev = rawBuf[rawBuf.length - 1];
    if (!prev) {
      rawBuf.push(to);
      return;
    }
    const dist = Math.hypot(to.x - prev.x, to.y - prev.y);
    if (dist < step) {
      rawBuf.push(to);
      return;
    }
    rawBuf.push(...stampAlongSegment(prev, to, step));
  }

  private drainRing(n: number): void {
    const live = this.op;
    const zoom = this.view.zoom || 1;
    const pressureSensitive = live.kind === "draw" && live.pressureSensitive;
    const speedInk = live.kind === "draw" ? (live.speedInk ?? 0) : 0;
    const speedFade = live.kind === "draw" ? (live.speedFade ?? 0) : 0;
    const speedBlot = live.kind === "draw" ? (live.speedBlotBlend ?? 0) : 0;
    const trackPace = speedInk > 0 || speedFade > 0 || speedBlot > 0;
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
      const contact = live.points[0];
      if (contact && hasStylusPressure(this.attackPeak)) {
        contact.pressure = this.attackPeak;
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
      live.points = straightenFromAnchor(live.points, anchor, point);
      if (reshapeLive) this.liveRaw = [...live.points];
      this.lastPoint = point;
      this.disc.reset(live.points[0]!);
      for (let i = 1; i < live.points.length; i++) this.disc.commit(live.points[i]!);
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
        if (point.slowness !== undefined) origin.slowness = point.slowness;
        this.collapseToOrigin(origin);
        return;
      }
    }

    if (live.kind === "draw" && live.highlight === true) {
      const chisel =
        inkLineWidth(live.baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE;
      const next = [...live.points, point];
      const trimmed = trimHighlightLiftHook(next, chisel);
      const lastKept = trimmed[trimmed.length - 1];
      if (lastKept && (lastKept.x !== point.x || lastKept.y !== point.y)) {
        return;
      }
    }

    const step = this.stampStep(point);
    if (reshapeLive) {
      this.appendRaw(point, step);
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

    this.dropTransientTip();
    live.points = [origin];
    this.disc.reset(origin);
    this.lastPoint = origin;
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

  private tickDwell(nowMs: number): void {
    if (this.attackBuffer) return;
    const live = this.op;
    if (live.kind !== "draw") return;
    const paceOn =
      (live.speedInk ?? 0) > 0 ||
      (live.speedBlotBlend ?? 0) > 0 ||
      (live.speedFade ?? 0) > 0;
    if (!paceOn) return;
    if (live.points.length === 0) return;
    if (nowMs - this.lastMoveWall < 60) return;
    if (nowMs - this.lastDwellTickWall < 32 && this.lastDwellTickWall > 0) return;
    this.lastDwellTickWall = nowMs;
    if (this.dwellCount >= blotTicksToFull(live.speedBlotBlend ?? 0)) return;
    this.dwellCount += 1;
    live.blotTipGrow = blotGrowTFromTicks(this.dwellCount, live.speedBlotBlend ?? 0);
    this.smoothedSpeed = smoothSpeed(this.smoothedSpeed, 0);
    const last = this.lastPoint;
    if (!last) return;
    const dwellPoint: ScenePoint = {
      ...last,
      slowness: inkSlowness(this.smoothedSpeed),
    };
    last.slowness = dwellPoint.slowness;
    const tip = live.points[live.points.length - 1];
    if (tip) tip.slowness = dwellPoint.slowness;
    if (live.pressureSensitive && hasStylusPressure(last.pressure)) {
      dwellPoint.pressure = this.smoothedPressure;
    }
    const dwellNib = Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6);
    if (this.disc.wouldStayDisc(dwellPoint, dwellNib)) {
      const contact = live.points[0];
      if (contact) {
        contact.slowness = dwellPoint.slowness;
        if (hasStylusPressure(dwellPoint.pressure)) {
          contact.pressure = Math.max(contact.pressure, dwellPoint.pressure);
        }
      }
      if ((live.speedBlotBlend ?? 0) > 1e-3 && contact) {
        live.points.push({
          x: contact.x,
          y: contact.y,
          pressure: contact.pressure,
          slowness: dwellPoint.slowness,
        });
      }
      this.lastPoint = contact ?? last;
      return;
    }
    if (tip && hasStylusPressure(dwellPoint.pressure)) {
      tip.pressure = dwellPoint.pressure;
    }
    this.lastPoint = dwellPoint;
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
    if (live.kind === "draw") live.blotTipGrow = 0;
    return true;
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
    live.points = reshaped.points;
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
