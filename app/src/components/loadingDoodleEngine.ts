/**
 * The loading doodle's ink: strokes, their smoothing and their fade.
 *
 * One engine, run by both hosts of the doodle. On the page it is fed pointer
 * events; on Android, while the app is starting, it runs in a worker and is
 * fed the pen's samples straight from the system (see `nativeDoodle`), so a
 * busy page cannot hold the pen back. Either way the strokes are the app's own
 * ink, drawn by the same code with the same settings.
 *
 * Committed strokes are cached in a backing bitmap. The old implementation
 * replayed every point of every retained stroke on every rAF, so the doodle
 * consumed progressively more of the UI thread while somebody wrote. That
 * starved both pointer delivery and the loading spinner.
 */

import { trailDistances, trailingPoints } from "./loadingDoodleTrail";

import { smoothInkPoints } from "../canvas/inkSmoothing";
import {
  applyInkOp,
  applyInkOpFrom,
  inkLineWidth,
  inkSlowness,
  pointerPressure,
  smoothPressure,
  smoothSpeed,
  type InkDrawOp,
  type ScenePoint,
} from "../canvas/rasterInk";

export const DOODLE_TTL_MS = 6_666;
export const DOODLE_ERASE_MS = 1_800;

/** The ink settings a doodle stroke is drawn with — read on the page, where they are stored. */
export interface DoodleInk {
  penWidth: number;
  baseWidth: number;
  maxFullness: number;
  pressureSensitive: boolean;
  inkColor: string;
  pressureClip: number;
  boldness: number;
  speedInk: number;
  speedBlotBlend: number;
  grain: number;
  speedFade: number;
  smoothing: number;
}

/** One pen sample, in CSS px from the doodle's top-left. */
export interface DoodleSample {
  x: number;
  y: number;
  /** Milliseconds on any steady clock; only differences are used. */
  t: number;
  /** As a pointer event reports it. */
  pressure: number;
  pointerType: string;
}

export type DoodleCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface DoodleEngine {
  setInk(ink: DoodleInk): void;
  /** Waits for a stroke in progress to lift. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  begin(sample: DoodleSample): void;
  move(samples: readonly DoodleSample[]): void;
  /** `lifted` is where the pen came up; null when the stroke was cancelled. */
  end(lifted: DoodleSample | null): void;
  drawing(): boolean;
  dispose(): void;
}

interface Stroke {
  op: InkDrawOp;
  at: number;
  distances: number[];
}

type Ctx = CanvasRenderingContext2D;

export function makeDoodleDrawOp(live: DoodleInk, points: ScenePoint[]): InkDrawOp {
  const speed = live.speedInk;
  return {
    kind: "draw",
    color: live.inkColor,
    baseWidth: live.baseWidth,
    maxFullness: live.maxFullness,
    pressureClip: live.pressureClip,
    pressureSensitive: live.pressureSensitive,
    speedInk: speed,
    // Always stamped. Left off, the renderer reads the stored setting, which
    // a worker cannot; this is that same setting, read on the page.
    speedBlotBlend: live.speedBlotBlend,
    ...(speed > 0 || live.speedBlotBlend > 0 || live.speedFade > 0
      ? { speedFade: live.speedFade }
      : {}),
    ...(live.grain > 0 ? { grain: live.grain } : {}),
    boldness: live.boldness,
    points,
  };
}

const frame = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

export function createDoodleEngine(
  canvas: DoodleCanvas,
  makeCanvas: () => DoodleCanvas,
  ink: DoodleInk,
  onStroke: (active: boolean) => void,
): DoodleEngine | null {
  const ctx = canvas.getContext("2d") as Ctx | null;
  const backing = makeCanvas();
  const backingCtx = backing.getContext("2d") as Ctx | null;
  const liveCanvas = makeCanvas();
  const liveCtx = liveCanvas.getContext("2d") as Ctx | null;
  if (!ctx || !backingCtx || !liveCtx) return null;

  let live = ink;
  let dpr = 1;
  let strokes: Stroke[] = [];
  let stroke: ScenePoint[] | null = null;
  let liveFrom = 0;
  let pressureEma = 0;
  let speedEma = 0;
  let lastSample: { x: number; y: number; t: number } | null = null;
  let paintRaf: number | null = null;
  let eraseRaf: number | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stableCount = 0;
  let pendingSize: { w: number; h: number; dpr: number } | null = null;
  let disposed = false;

  const drawCommitted = (op: InkDrawOp) => {
    backingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    applyInkOp(backingCtx, op, dpr);
  };

  const rebuildBacking = () => {
    backingCtx.setTransform(1, 0, 0, 1, 0, 0);
    backingCtx.clearRect(0, 0, backing.width, backing.height);
    const now = performance.now();
    const stable = strokes.filter((s) => now < s.at + DOODLE_TTL_MS);
    for (const s of stable) drawCommitted(s.op);
    stableCount = stable.length;
  };

  const presentBacking = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(backing, 0, 0);
    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of strokes) {
      const progress = (now - s.at - DOODLE_TTL_MS) / DOODLE_ERASE_MS;
      if (progress < 0 || progress >= 1) continue;
      applyInkOp(ctx, {
        ...s.op,
        points: trailingPoints(s.op.points, s.distances, progress),
      }, dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(liveCanvas, 0, 0);
  };

  const applySize = (w: number, h: number, nextDpr: number) => {
    dpr = nextDpr;
    const nextW = Math.max(1, Math.floor(w * dpr));
    const nextH = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    // Effects can restart while the visible canvas keeps its dimensions
    // (StrictMode, hot reload). The new live bitmap still starts at 300x150.
    if (liveCanvas.width !== nextW || liveCanvas.height !== nextH) {
      liveCanvas.width = nextW;
      liveCanvas.height = nextH;
    }
    if (backing.width !== nextW || backing.height !== nextH) {
      backing.width = nextW;
      backing.height = nextH;
      rebuildBacking();
    }
  };

  const paintTail = () => {
    const points = stroke;
    if (!points || points.length === 0) return;
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Keep the live path O(new points). Reshaping and repainting the growing
    // polyline here made every later frame more expensive than the prior one.
    // Shape the final ephemeral stroke once on lift instead.
    liveFrom = applyInkOpFrom(liveCtx, makeDoodleDrawOp(live, points), liveFrom, dpr);
    presentBacking();
  };

  const schedulePaint = () => {
    if (paintRaf != null) return;
    paintRaf = frame(() => {
      paintRaf = null;
      paintTail();
    });
  };

  const scheduleExpiry = () => {
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (eraseRaf != null || disposed) return;
    const first = strokes[0];
    if (!first) return;
    const due = first.at + DOODLE_TTL_MS;
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      const sweep = () => {
        eraseRaf = null;
        if (disposed) return;
        const now = performance.now();
        strokes = strokes.filter((s) => s.at + DOODLE_TTL_MS + DOODLE_ERASE_MS > now);
        const stable = strokes.filter((s) => now < s.at + DOODLE_TTL_MS).length;
        if (stable !== stableCount) rebuildBacking();
        presentBacking();
        if (strokes.some((s) => now >= s.at + DOODLE_TTL_MS)) {
          eraseRaf = frame(sweep);
        } else scheduleExpiry();
      };
      sweep();
    }, Math.max(0, due - performance.now()));
  };

  const point = (sample: DoodleSample): ScenePoint => {
    const { x, y, t } = sample;
    const raw = pointerPressure(sample.pressure, sample.pointerType);
    const pressure = raw < 0 ? raw : smoothPressure(pressureEma || raw, raw);
    if (raw >= 0) pressureEma = pressure;

    let slowness: number | undefined;
    if (live.speedInk > 0 || live.speedFade > 0 || live.speedBlotBlend > 0) {
      const last = lastSample;
      if (last && t > last.t) {
        const dist = Math.hypot(x - last.x, y - last.y);
        speedEma = smoothSpeed(speedEma, dist / (t - last.t));
      } else {
        speedEma = smoothSpeed(speedEma, 0);
      }
      slowness = inkSlowness(speedEma);
    }
    lastSample = { x, y, t };
    return { x, y, pressure, ...(slowness != null ? { slowness } : {}) };
  };

  presentBacking();

  return {
    setInk(next) {
      live = next;
    },
    resize(w, h, nextDpr) {
      if (stroke) {
        pendingSize = { w, h, dpr: nextDpr };
        return;
      }
      pendingSize = null;
      applySize(w, h, nextDpr);
      presentBacking();
    },
    begin(sample) {
      if (stroke || disposed) return;
      pressureEma = 0;
      speedEma = 0;
      lastSample = null;
      onStroke(true);
      liveFrom = 0;
      stroke = [point(sample)];
      paintTail();
    },
    move(samples) {
      if (!stroke) return;
      for (const sample of samples) stroke.push(point(sample));
      schedulePaint();
    },
    end(lifted) {
      if (!stroke) return;
      let points = stroke;
      const last = points[points.length - 1];
      if (lifted) {
        const at = point(lifted);
        if (!last || Math.hypot(at.x - last.x, at.y - last.y) > 0.25) points = [...points, at];
      }
      if (points.length > 1 && live.smoothing > 0) {
        points = smoothInkPoints(points, live.smoothing, inkLineWidth(live.baseWidth, 0, false));
      }
      if (points.length > 0) {
        const op = makeDoodleDrawOp(live, points);
        strokes.push({ op, at: performance.now(), distances: trailDistances(points) });
        drawCommitted(op);
        stableCount += 1;
      }
      stroke = null;
      liveCtx.setTransform(1, 0, 0, 1, 0, 0);
      liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      liveFrom = 0;
      lastSample = null;
      onStroke(false);
      if (pendingSize) {
        const size = pendingSize;
        pendingSize = null;
        applySize(size.w, size.h, size.dpr);
      }
      presentBacking();
      scheduleExpiry();
    },
    drawing: () => stroke != null,
    dispose() {
      disposed = true;
      if (stroke) onStroke(false);
      stroke = null;
      if (paintRaf != null) cancelFrame(paintRaf);
      if (eraseRaf != null) cancelFrame(eraseRaf);
      if (expiryTimer != null) clearTimeout(expiryTimer);
    },
  };
}
