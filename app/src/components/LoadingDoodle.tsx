/**
 * Ephemeral pen doodle for loading / gate overlays.
 *
 * Same global ink prefs Board/Scratchpad use (tool prefs + Settings events)
 * and the same RasterInk draw path (`applyInkOp` / ribbon), at zoom = 1.
 * Plain canvas only — not RasterInkLayer / tile cache — so a waiting gate
 * cannot tax tablet scroll. The strokes themselves are `loadingDoodleEngine`.
 *
 * Color: {@link resolveInkColor} with the app theme (same as Board), not the
 * veil's muted overlay color.
 *
 * `nativeInput`: on Android a second canvas over this one is drawn by a worker
 * from the pen's samples as the system reports them (`util/nativeDoodle`), so
 * a page busy starting up cannot hold the pen back. Only where nothing else
 * takes touches over the doodle — the start-up and loading screens.
 */

import { useEffect, useRef, useState } from "react";

import { resolveInkColor } from "../canvas/inkColors";
import { inkBaseWidthForZoom } from "../canvas/rasterInk";
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
import { INK_TOOL_PREFS_EVENT, loadInkToolPrefs } from "../util/inkToolPrefs";
import {
  beginLoadingDoodle,
  endLoadingDoodle,
} from "../util/loadingDoodleActivity";
import { nativeDoodleHost } from "../util/nativeDoodle";
import { createDoodleEngine, type DoodleInk, type DoodleSample } from "./loadingDoodleEngine";

const INK_EVENTS = [
  "lc-ink-smoothing",
  "lc-ink-pressure-clip",
  "lc-ink-speed",
  INK_SPEED_BLOT_BLEND_EVENT,
  INK_GRAIN_EVENT,
  INK_SPEED_FADE_EVENT,
  INK_BOLDNESS_EVENT,
  INK_TOOL_PREFS_EVENT,
];

/** How often a native doodle's place on screen is checked. */
const NATIVE_PLACE_MS = 400;

let nextNativeId = 1;

function loadLiveInk(themeId: string): DoodleInk {
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

const bitmapScale = () => Math.min(window.devicePixelRatio || 1, 2);

export function LoadingDoodle({
  className,
  themeId,
  nativeInput = false,
}: {
  className?: string;
  /** App theme — defaults to stored theme when omitted (status dialogs). */
  themeId?: string;
  /** Draw from the system's pen samples where the platform allows — see above. */
  nativeInput?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nativeRef = useRef<HTMLCanvasElement | null>(null);
  const doodleTokenRef = useRef<object>({});
  const themeIdRef = useRef(themeId ?? loadThemeId());
  themeIdRef.current = themeId ?? loadThemeId();
  const reloadRef = useRef<() => void>(() => {});
  const nativeInkRef = useRef<() => void>(() => {});
  const [native, setNative] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const token = doodleTokenRef.current;
    const engine = createDoodleEngine(
      canvas,
      () => document.createElement("canvas"),
      loadLiveInk(themeIdRef.current),
      (active) => (active ? beginLoadingDoodle(token) : endLoadingDoodle(token)),
    );
    if (!engine) return;
    const reloadInk = () => engine.setInk(loadLiveInk(themeIdRef.current));
    reloadRef.current = reloadInk;
    for (const name of INK_EVENTS) window.addEventListener(name, reloadInk);

    let pointerId: number | null = null;
    let bounds: DOMRect | null = null;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      engine.resize(rect.width, rect.height, bitmapScale());
      if (!engine.drawing()) {
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
    };

    const sample = (event: PointerEvent, rect: DOMRect): DoodleSample => ({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      t: event.timeStamp || performance.now(),
      pressure: event.pressure,
      pointerType: event.pointerType,
    });

    const onDown = (event: PointerEvent) => {
      if (pointerId != null) return;
      if (event.button !== 0 && event.pointerType !== "pen") return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
      pointerId = event.pointerId;
      bounds = canvas.getBoundingClientRect();
      engine.begin(sample(event, bounds));
    };
    const onMove = (event: PointerEvent) => {
      if (pointerId == null || event.pointerId !== pointerId) return;
      const rect = bounds ?? canvas.getBoundingClientRect();
      const coalesced = event.getCoalescedEvents?.();
      const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
      engine.move(batch.map((e) => sample(e, rect)));
    };
    const onUp = (event: PointerEvent) => {
      if (pointerId == null || event.pointerId !== pointerId) return;
      pointerId = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      const rect = bounds ?? canvas.getBoundingClientRect();
      bounds = null;
      engine.end(event.type === "pointerup" ? sample(event, rect) : null);
      resize();
    };

    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("lostpointercapture", onUp);
    return () => {
      if (pointerId != null) {
        try { canvas.releasePointerCapture(pointerId); } catch { /* detached */ }
      }
      engine.dispose();
      endLoadingDoodle(token);
      reloadRef.current = () => {};
      ro.disconnect();
      for (const name of INK_EVENTS) window.removeEventListener(name, reloadInk);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("lostpointercapture", onUp);
    };
  }, []);

  // A theme change recolours both doodles' next strokes.
  useEffect(() => {
    reloadRef.current();
    nativeInkRef.current();
  }, [themeId]);

  // Whether this platform has the native pen path; the canvas for it mounts once it does.
  useEffect(() => {
    if (!nativeInput) return;
    let live = true;
    void nativeDoodleHost().then((worker) => {
      if (live && worker) setNative(true);
    });
    return () => {
      live = false;
    };
  }, [nativeInput]);

  useEffect(() => {
    const canvas = nativeRef.current;
    if (!native || !canvas) return;
    let worker: Worker | null = null;
    let disposed = false;
    const id = nextNativeId++;
    const token = {};
    let timer = 0;
    let last = "";

    const place = () => {
      const rect = canvas.getBoundingClientRect();
      // A dialog over the doodle takes its own touches: let them through.
      const enabled = rect.width > 1 && rect.height > 1 && !document.querySelector('[aria-modal="true"]');
      return {
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        dpr: window.devicePixelRatio || 1,
        scale: bitmapScale(),
        enabled,
      };
    };
    const sendPlace = () => {
      if (!worker) return;
      const next = place();
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      worker.postMessage({ type: "place", id, ...next });
    };
    const onWorker = (event: MessageEvent) => {
      const msg = event.data as { type?: string; id?: number; active?: boolean };
      if (msg.type !== "stroke" || msg.id !== id) return;
      if (msg.active) beginLoadingDoodle(token);
      else endLoadingDoodle(token);
    };
    const sendInk = () => worker?.postMessage({ type: "ink", id, ink: loadLiveInk(themeIdRef.current) });

    void nativeDoodleHost().then((host) => {
      if (disposed || !host) return;
      worker = host;
      let offscreen: OffscreenCanvas;
      try {
        offscreen = canvas.transferControlToOffscreen();
      } catch {
        return;
      }
      const first = place();
      last = JSON.stringify(first);
      host.addEventListener("message", onWorker);
      host.postMessage({ type: "attach", id, canvas: offscreen, ink: loadLiveInk(themeIdRef.current), ...first }, [offscreen]);
      timer = window.setInterval(sendPlace, NATIVE_PLACE_MS);
      nativeInkRef.current = sendInk;
      for (const name of INK_EVENTS) window.addEventListener(name, sendInk);
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      nativeInkRef.current = () => {};
      for (const name of INK_EVENTS) window.removeEventListener(name, sendInk);
      if (worker) {
        worker.postMessage({ type: "detach", id });
        worker.removeEventListener("message", onWorker);
      }
      endLoadingDoodle(token);
    };
  }, [native]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={["lc-loading-doodle", className].filter(Boolean).join(" ")}
        aria-hidden="true"
      />
      {native && (
        <canvas
          ref={nativeRef}
          className={["lc-loading-doodle", "lc-loading-doodle-native", className].filter(Boolean).join(" ")}
          aria-hidden="true"
        />
      )}
    </>
  );
}
