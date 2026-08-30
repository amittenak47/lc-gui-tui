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
 * After {@link DOODLE_TTL_MS}, each stroke erases from its oldest tip (tail)
 * toward the newest.
 */

import { useEffect, useRef } from "react";

import { resolveInkColor } from "../canvas/inkColors";
import { smoothInkPoints } from "../canvas/inkSmoothing";
import {
  applyInkOp,
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
import { loadInkSmoothing, loadInkSmoothingMode } from "../util/inkSmoothingPref";
import {
  INK_SPEED_BLOT_BLEND_EVENT,
  INK_SPEED_FADE_EVENT,
  INK_SPEED_BODY_ACCENT_EVENT,
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  loadInkSpeedFade,
  loadInkSpeedBodyAccent,
} from "../util/inkSpeedPref";
import { loadInkToolPrefs } from "../util/inkToolPrefs";

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
  speedFade: number;
  speedBodyAccent: number;
  smoothing: number;
  smoothingMode: "lift" | "live";
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
    speedFade: loadInkSpeedFade(),
    speedBodyAccent: loadInkSpeedBodyAccent(),
    smoothing: loadInkSmoothing(),
    smoothingMode: loadInkSmoothingMode(),
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
          ...(speed > 0 ? { speedBodyAccent: live.speedBodyAccent } : {}),
        }
      : {}),
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
  const themeIdRef = useRef(themeId ?? loadThemeId());
  themeIdRef.current = themeId ?? loadThemeId();
  const inkRef = useRef<InkLive>(loadLiveInk(themeIdRef.current));
  const dprRef = useRef(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    inkRef.current = loadLiveInk(themeIdRef.current);

    const reloadInk = () => {
      inkRef.current = loadLiveInk(themeIdRef.current);
    };
    window.addEventListener("lc-ink-smoothing", reloadInk);
    window.addEventListener("lc-ink-pressure-clip", reloadInk);
    window.addEventListener("lc-ink-speed", reloadInk);
    window.addEventListener(INK_SPEED_BLOT_BLEND_EVENT, reloadInk);
    window.addEventListener(INK_SPEED_FADE_EVENT, reloadInk);
    window.addEventListener(INK_SPEED_BODY_ACCENT_EVENT, reloadInk);
    window.addEventListener(INK_BOLDNESS_EVENT, reloadInk);

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
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    const paint = (now = performance.now()) => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      const dpr = dprRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const pixelScale = dpr;

      const kept: Stroke[] = [];
      for (const stroke of strokesRef.current) {
        const age = now - stroke.at;
        if (age >= DOODLE_TTL_MS + ERASE_MS) continue;
        let op = stroke.op;
        if (age > DOODLE_TTL_MS && stroke.op.points.length > 1) {
          const progress = Math.min(1, (age - DOODLE_TTL_MS) / ERASE_MS);
          const drop = Math.floor(progress * (stroke.op.points.length - 1));
          const visible = stroke.op.points.slice(drop);
          if (visible.length < 2) continue;
          op = { ...stroke.op, points: visible };
        }
        applyInkOp(ctx, op, pixelScale);
        kept.push(stroke);
      }
      strokesRef.current = kept;

      if (strokeRef.current) {
        const live = inkRef.current;
        const points =
          live.smoothingMode === "live" && live.smoothing > 0
            ? smoothInkPoints(
                strokeRef.current,
                live.smoothing,
                inkLineWidth(live.baseWidth, 0, false),
              )
            : strokeRef.current;
        applyInkOp(ctx, makeDrawOp(live, points), pixelScale);
      }
    };

    const loop = () => {
      paint();
      rafRef.current = requestAnimationFrame(loop);
    };

    const pointFrom = (event: PointerEvent): ScenePoint => {
      const rect = canvas.getBoundingClientRect();
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
      strokeRef.current = [pointFrom(event)];
    };
    const onMove = (event: PointerEvent) => {
      if (!strokeRef.current) return;
      strokeRef.current.push(pointFrom(event));
    };
    const onUp = (event: PointerEvent) => {
      if (!strokeRef.current) return;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      const live = inkRef.current;
      let points = strokeRef.current;
      if (points.length > 1 && live.smoothing > 0) {
        points = smoothInkPoints(
          points,
          live.smoothing,
          inkLineWidth(live.baseWidth, 0, false),
        );
      }
      if (points.length > 1) {
        strokesRef.current.push({
          op: makeDrawOp(live, points),
          at: performance.now(),
        });
      }
      strokeRef.current = null;
      lastSampleRef.current = null;
    };

    resize();
    rafRef.current = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      window.removeEventListener("lc-ink-smoothing", reloadInk);
      window.removeEventListener("lc-ink-pressure-clip", reloadInk);
      window.removeEventListener("lc-ink-speed", reloadInk);
      window.removeEventListener(INK_SPEED_BLOT_BLEND_EVENT, reloadInk);
      window.removeEventListener(INK_SPEED_FADE_EVENT, reloadInk);
      window.removeEventListener(INK_SPEED_BODY_ACCENT_EVENT, reloadInk);
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
