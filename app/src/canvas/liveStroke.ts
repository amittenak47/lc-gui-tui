/**
 * One in-progress ink gesture.
 *
 * RasterInkLayer owns capture, the overlay, the stroke-start snapshot, and rAF.
 * This session owns ingest, attack/dwell/stamp, reshape, and live overlay paint.
 * Step 2 keeps today's append rule: every `dist < step` sample still becomes a
 * point. Later steps change how the ring is drained, not this public surface.
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
} from "./rasterInk";
import { paintLiveOp } from "./inkTiles";
import {
  smoothLiveInkPoints,
  type InkSmoothingMode,
  type LiveSmoothCache,
} from "./inkSmoothing";
import { straightenFromAnchor } from "./straightAnchor";

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
  private readonly uiWidth: number;
  private readonly boldness: number;
  private readonly smoothing: number;
  private readonly smoothingMode: InkSmoothingMode;
  private readonly getStraightAnchor: () => number | null;
  private readonly onNeedPaint: () => void;
  private pending: LivePointerSample[] = [];
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

  constructor(init: BeginLiveStroke) {
    this.view = init.view;
    this.box = init.box;
    this.rect = init.rect;
    this.uiWidth = init.uiWidth;
    this.boldness = init.boldness;
    this.smoothing = init.smoothing;
    this.smoothingMode = init.smoothingMode;
    this.getStraightAnchor = init.getStraightAnchor;
    this.onNeedPaint = init.onNeedPaint;
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
    for (const sample of batch) this.pending.push(sample);
    this.lastEventTimeMs = batch[batch.length - 1]!.timeStamp;
    this.ingested += batch.length;
  }

  tick(nowMs: number): void {
    if (this.closed) return;
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) this.drainBatch(batch, nowMs);
    this.tickDwell(nowMs);
    if (DEBUG_INK || inkMetrics.enabled) {
      inkMetrics.live({
        ringSamples: this.ingested,
        spineN: this.op.points.length,
        transientTip: false,
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
      return "fallback";
    }
    if (isHostBoundOp(this.op)) {
      this.markPath("hostBound");
      this.lastPaintFallback = true;
      return "fallback";
    }
    if (
      canvas.width !== Math.round(this.box.width * dpr) ||
      canvas.height !== Math.round(this.box.height * dpr)
    ) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      return "fallback";
    }
    if (!snap || snap.width !== canvas.width || snap.height !== canvas.height) {
      this.markPath("paintFrame");
      this.lastPaintFallback = true;
      return "fallback";
    }

    const marginY = this.box.marginY;
    const baseView: ViewportTransform = {
      ...this.view,
      scrollY: this.view.scrollY - marginY / this.view.zoom,
      height: this.view.height - 2 * marginY,
    };
    const drawView = overdrawnViewport(baseView, marginY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(snap, 0, 0);
    paintLiveOp(ctx, this.op, drawView, dpr, clip, hosts);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    return this.op;
  }

  abandon(): void {
    this.closed = true;
    this.stopDwell();
    this.pending.length = 0;
    this.attackBuffer = null;
    this.liveRaw = null;
    this.lastPoint = null;
    this.rawPoint = null;
  }

  overlayDirtyPx(_prev: PixelRect | null, _view: ViewportTransform, dpr: number): PixelRect {
    return {
      x: 0,
      y: 0,
      w: Math.max(1, Math.round(this.box.width * dpr)),
      h: Math.max(1, Math.round(this.box.height * dpr)),
    };
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

  private drainBatch(batch: readonly LivePointerSample[], _nowMs: number): void {
    const live = this.op;
    const zoom = this.view.zoom || 1;
    const pressureSensitive = live.kind === "draw" && live.pressureSensitive;
    const maxFullness = live.kind === "draw" ? live.maxFullness : 1;
    const pressureClip = live.kind === "draw" ? live.pressureClip : 1;
    const speedInk = live.kind === "draw" ? (live.speedInk ?? 0) : 0;
    const speedFade = live.kind === "draw" ? (live.speedFade ?? 0) : 0;
    const speedBlot = live.kind === "draw" ? (live.speedBlotBlend ?? 0) : 0;
    const trackPace = speedInk > 0 || speedFade > 0 || speedBlot > 0;
    const reshapeLive = live.kind === "draw" && this.reshapeActive();

    if (this.attackBuffer && live.kind === "draw") {
      for (const sample of batch) {
        const rawLast = this.rawPoint;
        if (!rawLast) break;
        const raw = scenePointFromPointer(
          sample.clientX,
          sample.clientY,
          this.rect,
          this.view,
          sample.pressure,
          sample.pointerType,
        );
        const dt = sample.timeStamp - this.lastSampleTime;
        this.lastSampleTime = sample.timeStamp;
        this.noteInkTravel(raw.x - rawLast.x, raw.y - rawLast.y, zoom, live);

        if (pressureSensitive && hasStylusPressure(raw.pressure)) {
          if (raw.pressure > this.attackPeak) this.attackPeak = raw.pressure;
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
        this.attackBuffer.push(raw);
        this.attackCount += 1;
      }

      const contact = live.points[0];
      if (contact && hasStylusPressure(this.attackPeak)) {
        contact.pressure = this.attackPeak;
      }

      const last = batch[batch.length - 1];
      const shouldFlush =
        !!last &&
        (last.timeStamp - this.attackStart >= INK_ATTACK_MS || this.attackCount >= 3);
      if (shouldFlush) this.flushAttackBuffer();
      return;
    }

    for (const sample of batch) {
      const last = this.lastPoint;
      const rawLast = this.rawPoint;
      if (!last || !rawLast) break;
      const raw = scenePointFromPointer(
        sample.clientX,
        sample.clientY,
        this.rect,
        this.view,
        sample.pressure,
        sample.pointerType,
      );
      const dt = sample.timeStamp - this.lastSampleTime;
      this.lastSampleTime = sample.timeStamp;
      this.noteInkTravel(raw.x - rawLast.x, raw.y - rawLast.y, zoom, live);

      if (pressureSensitive && hasStylusPressure(raw.pressure)) {
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
      const point = raw;

      const anchor = this.getStraightAnchor();
      if (live.kind === "draw" && anchor != null) {
        this.straightTouched = true;
        live.points = straightenFromAnchor(live.points, anchor, point);
        if (reshapeLive) this.liveRaw = [...live.points];
        this.lastPoint = point;
        continue;
      }

      if (live.kind === "draw" && live.highlight !== true && live.points[0]) {
        const nib = Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6);
        const trail = reshapeLive
          ? [...(this.liveRaw ?? live.points), point]
          : [...live.points, point];
        if (isDiscPrimaryPath(trail, nib)) {
          const origin = live.points[0];
          if (
            hasStylusPressure(point.pressure) &&
            point.pressure > origin.pressure
          ) {
            origin.pressure = point.pressure;
          }
          if (point.slowness !== undefined) origin.slowness = point.slowness;
          this.lastPoint = origin;
          live.points = [origin];
          if (reshapeLive) this.liveRaw = [origin];
          continue;
        }
      }

      if (live.kind === "draw" && live.highlight === true) {
        const chisel =
          inkLineWidth(live.baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE;
        const next = [...live.points, point];
        const trimmed = trimHighlightLiftHook(next, chisel);
        const lastKept = trimmed[trimmed.length - 1];
        if (lastKept && (lastKept.x !== point.x || lastKept.y !== point.y)) {
          continue;
        }
      }

      const step =
        live.kind === "erase"
          ? Math.max(live.radius * 0.45, 0.5)
          : (() => {
              const style = inkStrokeStyle(
                this.uiWidth,
                maxFullness,
                point.pressure,
                pressureClip,
                pressureSensitive,
                0,
                point.slowness ?? INK_SLOWNESS_NEUTRAL,
                speedInk,
                live.kind === "draw" && live.highlight === true,
                live.kind === "draw" ? (live.boldness ?? this.boldness) : 1,
                live.kind === "draw" ? (live.speedFade ?? 0) : 0,
              );
              const dense =
                speedInk > 0 ||
                (pressureSensitive && hasStylusPressure(point.pressure));
              return Math.max(
                style.lineWidth * (dense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
                0.5,
              );
            })();
      const stamps = stampAlongSegment(last, point, step);
      if (reshapeLive) {
        const rawBuf = this.liveRaw ?? (this.liveRaw = []);
        rawBuf.push(...stamps);
      } else {
        live.points.push(...stamps);
      }
      this.lastPoint = point;
    }
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

    const width = this.uiWidth;
    const origin = buf[0];
    this.rawPoint = buf[buf.length - 1] ?? origin;
    const nib = Math.max(inkLineWidth(live.baseWidth, 0, false), 1e-6);
    if (isDiscPrimaryPath(buf, nib)) {
      this.lastPoint = origin;
      if (this.reshapeActive()) {
        this.liveRaw = [origin];
        live.points = [origin];
      } else {
        this.liveRaw = null;
        live.points = [origin];
      }
      return;
    }

    const stamps: ScenePoint[] = [origin];
    let last = origin;
    this.lastPoint = last;
    for (let i = 1; i < buf.length; i++) {
      const point = buf[i]!;
      if (isDiscPrimaryPath([...stamps, point], nib)) continue;
      const style = inkStrokeStyle(
        width,
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
      const dense =
        (live.speedInk ?? 0) > 0 ||
        (live.pressureSensitive && hasStylusPressure(point.pressure));
      const step = Math.max(
        style.lineWidth * (dense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
        0.5,
      );
      stamps.push(...stampAlongSegment(last, point, step));
      last = point;
    }
    this.lastPoint = last;
    if (this.reshapeActive()) {
      this.liveRaw = stamps;
      live.points = stamps;
    } else {
      this.liveRaw = null;
      live.points = stamps;
    }
  }

  private settleTip(): void {
    if (this.reshapeActive()) return;
    const live = this.op;
    const last = this.lastPoint;
    const raw = this.rawPoint;
    if (live.kind !== "draw" || !last || !raw) return;
    if (Math.hypot(raw.x - last.x, raw.y - last.y) < 1e-3) return;
    const style = inkStrokeStyle(
      live.baseWidth,
      live.maxFullness,
      raw.pressure,
      live.pressureClip,
      live.pressureSensitive,
      0,
      raw.slowness ?? INK_SLOWNESS_NEUTRAL,
      live.speedInk ?? 0,
      false,
      live.boldness ?? this.boldness,
      live.speedFade ?? 0,
    );
    const step = Math.max(style.lineWidth * INK_STEP_FACTOR_PRESSURE, 0.5);
    live.points.push(...stampAlongSegment(last, raw, step));
    this.lastPoint = raw;
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
    if (isDiscPrimaryPath([...live.points, dwellPoint], dwellNib)) {
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
