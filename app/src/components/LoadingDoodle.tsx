/**
 * Ephemeral pen doodle for loading / gate overlays.
 *
 * Same global ink prefs Board/Scratchpad use (tool prefs + Settings events)
 * and the same RasterInk draw path (`applyInkOp` / ribbon), at zoom = 1.
 * Plain canvas only — not RasterInkLayer / tile cache — so a waiting gate
 * cannot tax tablet scroll.
 *
 * Color: {@link resolveInkColor} with the app theme (same as Board), not the
 * veil's muted overlay color.
 *
 * Committed strokes are cached in a backing bitmap. The old implementation
 * replayed every point of every retained stroke on every rAF, so the doodle
 * consumed progressively more of the UI thread while somebody wrote. That
 * starved both pointer delivery and the loading spinner.
 */

import { useEffect, useRef } from "react";

import { resolveInkColor } from "../canvas/inkColors";
import { smoothInkPoints } from "../canvas/inkSmoothing";
import {
  applyInkOp,
  applyInkOpFrom,
  inkBaseWidthForZoom,
  inkLineWidth,
  inkSlowness,
  pointerPressure,
  smoothPressure,
  smoothSpeed,
  type InkDrawOp,
  type ScenePoint,
} from "../canvas/rasterInk";
import { loadThemeId } from "../theme/appThemes";
import { INK_BOLDNESS_EVENT, loadInkBoldness } from "../util/inkBoldnessPref";
import { loadInkPressureClip } from "../util/inkPressureClip";
import { loadInkSmoothing } from "../util/inkSmoothingPref";
import {
  INK_GRAIN_EVENT,
  INK_SPEED_BLOT_BLEND_EVENT,
  INK_SPEED_FADE_EVENT,
  loadInkGrain,
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  loadInkSpeedFade,
} from "../util/inkSpeedPref";
import { loadInkToolPrefs } from "../util/inkToolPrefs";
import {
  beginLoadingDoodle,
  endLoadingDoodle,
} from "../util/loadingDoodleActivity";

const DOODLE_TTL_MS = 6_666;
const ERASE_MS = 666;

interface Stroke {
  op: InkDrawOp;
  at: number;
}

interface InkLive {
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

function loadLiveInk(themeId: string): InkLive {
  const prefs = loadInkToolPrefs();
  const pressureSensitive = prefs.pressureSensitive;
  return {
    penWidth: prefs.penWidth,
    baseWidth: inkBaseWidthForZoom(prefs.penWidth, 1),
    maxFullness: pressureSensitive ? Math.min(prefs.inkFullness, 0.999) : 1,
    pressureSensitive,
    inkColor: resolveInkColor(themeId, prefs.inkColor),
    pressureClip: loadInkPressureClip(),
    boldness: loadInkBoldness(),
    speedInk: loadInkSpeed(),
    speedBlotBlend: loadInkSpeedBlotBlend(),
    grain: loadInkGrain(),
    speedFade: loadInkSpeedFade(),
    smoothing: loadInkSmoothing(),
  };
}

function makeDrawOp(live: InkLive, points: ScenePoint[]): InkDrawOp {
  const speed = live.speedInk;
  return {
    kind: "draw",
    color: live.inkColor,
    baseWidth: live.baseWidth,
    maxFullness: live.maxFullness,
    pressureClip: live.pressureClip,
    pressureSensitive: live.pressureSensitive,
    speedInk: speed,
    ...(speed > 0 || live.speedBlotBlend > 0 || live.speedFade > 0
      ? {
          speedBlotBlend: live.speedBlotBlend,
          speedFade: live.speedFade,
        }
      : {}),
    ...(live.grain > 0 ? { grain: live.grain } : {}),
    boldness: live.boldness,
    points,
  };
}

export function LoadingDoodle({
  className,
  themeId,
}: {
  className?: string;
  /** App theme — defaults to stored theme when omitted (status dialogs). */
  themeId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<ScenePoint[] | null>(null);
  const pressureEmaRef = useRef(0);
  const speedEmaRef = useRef(0);
  const lastSampleRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const rafRef = useRef<number | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const liveFromRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const pointerBoundsRef = useRef<DOMRect | null>(null);
  const doodleTokenRef = useRef<object>({});
  const themeIdRef = useRef(themeId ?? loadThemeId());
  themeIdRef.current = themeId ?? loadThemeId();
  const inkRef = useRef<InkLive>(loadLiveInk(themeIdRef.current));
  const dprRef = useRef(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const backing = document.createElement("canvas");
    const backingCtx = backing.getContext("2d");
    if (!backingCtx) return;

    inkRef.current = loadLiveInk(themeIdRef.current);

    const reloadInk = () => {
      inkRef.current = loadLiveInk(themeIdRef.current);
    };
    window.addEventListener("lc-ink-smoothing", reloadInk);
    window.addEventListener("lc-ink-pressure-clip", reloadInk);
    window.addEventListener("lc-ink-speed", reloadInk);
    window.addEventListener(INK_SPEED_BLOT_BLEND_EVENT, reloadInk);
    window.addEventListener(INK_GRAIN_EVENT, reloadInk);
    window.addEventListener(INK_SPEED_FADE_EVENT, reloadInk);
    window.addEventListener(INK_BOLDNESS_EVENT, reloadInk);

    const drawCommitted = (op: InkDrawOp) => {
      backingCtx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
      applyInkOp(backingCtx, op, dprRef.current);
    };

    const rebuildBacking = () => {
      backingCtx.setTransform(1, 0, 0, 1, 0, 0);
      backingCtx.clearRect(0, 0, backing.width, backing.height);
      for (const stroke of strokesRef.current) drawCommitted(stroke.op);
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      const nextW = Math.max(1, Math.floor(rect.width * dpr));
      const nextH = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== nextW || canvas.height !== nextH) {
        canvas.width = nextW;
        canvas.height = nextH;
      }
      if (backing.width !== nextW || backing.height !== nextH) {
        backing.width = nextW;
        backing.height = nextH;
        rebuildBacking();
      }
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    const presentBacking = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(backing, 0, 0);
    };

    const paintTail = () => {
      const points = strokeRef.current;
      if (!points || points.length === 0) return;
      const dpr = dprRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Keep the live path O(new points). Reshaping and repainting the growing
      // polyline here made every later frame more expensive than the prior one.
      // Shape the final ephemeral stroke once on lift instead.
      liveFromRef.current = applyInkOpFrom(
        ctx,
        makeDrawOp(inkRef.current, points),
        liveFromRef.current,
        dpr,
      );
    };

    const schedulePaint = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        paintTail();
      });
    };

    const scheduleExpiry = () => {
      if (expiryTimerRef.current != null) window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
      const first = strokesRef.current[0];
      if (!first) return;
      const due = first.at + DOODLE_TTL_MS + ERASE_MS;
      expiryTimerRef.current = window.setTimeout(() => {
        expiryTimerRef.current = null;
        const now = performance.now();
        strokesRef.current = strokesRef.current.filter(
          (stroke) => stroke.at + DOODLE_TTL_MS + ERASE_MS > now,
        );
        rebuildBacking();
        presentBacking();
        scheduleExpiry();
      }, Math.max(0, due - performance.now()));
    };

    const pointFrom = (event: PointerEvent, rect: DOMRect): ScenePoint => {
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const t = event.timeStamp || performance.now();
      const raw = pointerPressure(event.pressure, event.pointerType);
      const prev = pressureEmaRef.current;
      const pressure = raw < 0 ? raw : smoothPressure(prev || raw, raw);
      if (raw >= 0) pressureEmaRef.current = pressure;

      let slowness: number | undefined;
      if (
        inkRef.current.speedInk > 0 ||
        inkRef.current.speedFade > 0 ||
        inkRef.current.speedBlotBlend > 0
      ) {
        const last = lastSampleRef.current;
        if (last && t > last.t) {
          const dist = Math.hypot(x - last.x, y - last.y);
          const pxPerMs = dist / (t - last.t);
          speedEmaRef.current = smoothSpeed(speedEmaRef.current, pxPerMs);
        } else {
          speedEmaRef.current = smoothSpeed(speedEmaRef.current, 0);
        }
        slowness = inkSlowness(speedEmaRef.current);
      }
      lastSampleRef.current = { x, y, t };

      return {
        x,
        y,
        pressure,
        ...(slowness != null ? { slowness } : {}),
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== "pen") return;
      event.preventDefault();
      inkRef.current = loadLiveInk(themeIdRef.current);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
      pressureEmaRef.current = 0;
      speedEmaRef.current = 0;
      lastSampleRef.current = null;
      pointerIdRef.current = event.pointerId;
      pointerBoundsRef.current = canvas.getBoundingClientRect();
      beginLoadingDoodle(doodleTokenRef.current);
      liveFromRef.current = 0;
      strokeRef.current = [pointFrom(event, pointerBoundsRef.current)];
      schedulePaint();
    };
    const onMove = (event: PointerEvent) => {
      if (!strokeRef.current || event.pointerId !== pointerIdRef.current) return;
      const rect = pointerBoundsRef.current ?? canvas.getBoundingClientRect();
      const coalesced = event.getCoalescedEvents?.();
      const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
      for (const sample of batch) strokeRef.current.push(pointFrom(sample, rect));
      schedulePaint();
    };
    const onUp = (event: PointerEvent) => {
      if (!strokeRef.current || event.pointerId !== pointerIdRef.current) return;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      const live = inkRef.current;
      let points = strokeRef.current;
      const rect = pointerBoundsRef.current ?? canvas.getBoundingClientRect();
      const last = points[points.length - 1];
      const lifted = pointFrom(event, rect);
      if (!last || Math.hypot(lifted.x - last.x, lifted.y - last.y) > 0.25) {
        points = [...points, lifted];
      }
      if (points.length > 1 && live.smoothing > 0) {
        points = smoothInkPoints(
          points,
          live.smoothing,
          inkLineWidth(live.baseWidth, 0, false),
        );
      }
      if (points.length > 1) {
        const op = makeDrawOp(live, points);
        strokesRef.current.push({
          op,
          at: performance.now(),
        });
        drawCommitted(op);
        scheduleExpiry();
      }
      strokeRef.current = null;
      pointerIdRef.current = null;
      pointerBoundsRef.current = null;
      liveFromRef.current = 0;
      endLoadingDoodle(doodleTokenRef.current);
      lastSampleRef.current = null;
      presentBacking();
    };

    resize();
    presentBacking();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      endLoadingDoodle(doodleTokenRef.current);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (expiryTimerRef.current != null) window.clearTimeout(expiryTimerRef.current);
      ro.disconnect();
      window.removeEventListener("lc-ink-smoothing", reloadInk);
      window.removeEventListener("lc-ink-pressure-clip", reloadInk);
      window.removeEventListener("lc-ink-speed", reloadInk);
      window.removeEventListener(INK_SPEED_BLOT_BLEND_EVENT, reloadInk);
      window.removeEventListener(INK_GRAIN_EVENT, reloadInk);
      window.removeEventListener(INK_SPEED_FADE_EVENT, reloadInk);
      window.removeEventListener(INK_BOLDNESS_EVENT, reloadInk);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    inkRef.current = loadLiveInk(themeIdRef.current);
  }, [themeId]);

  return (
    <canvas
      ref={canvasRef}
      className={["lc-loading-doodle", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    />
  );
}
