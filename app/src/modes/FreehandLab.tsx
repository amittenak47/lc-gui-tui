/**
 * Comparison pad for `perfect-freehand` — not Speed Ink.
 *
 * Each frame rebuilds one outline from the live pointer samples and fills it.
 * Finished strokes are pixels. That is the tldraw model: O(samples) while the
 * pen is down, never a variable-width ribbon remesh.
 */

import { getStroke } from "perfect-freehand";
import { useEffect, useRef } from "react";

export interface FreehandLabProps {
  active: boolean;
}

const INK = "#1a1a1a";
const SIZE = 16;

export function freehandStrokeOptions(last: boolean, simulatePressure: boolean) {
  return {
    size: SIZE,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure,
    last,
  };
}

export function fillFreehandOutline(
  ctx: CanvasRenderingContext2D,
  outline: number[][],
): void {
  if (outline.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(outline[0]![0]!, outline[0]![1]!);
  for (let i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i]![0]!, outline[i]![1]!);
  }
  ctx.closePath();
  ctx.fill();
}

type Sample = [number, number, number];

export function FreehandLab({ active }: FreehandLabProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const committedRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Sample[]>([]);
  const drawingRef = useRef(false);
  const simulateRef = useRef(true);
  const paintsRef = useRef(0);
  const lastRafRef = useRef(0);
  const hudRef = useRef<HTMLPreElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawingRef.current = false;
    pointsRef.current = [];

    const sizeToHost = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, host.clientWidth);
      const cssH = Math.max(1, host.clientHeight);
      const pixelW = Math.max(1, Math.round(cssW * dpr));
      const pixelH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        let snap = committedRef.current;
        if (!snap) {
          snap = document.createElement("canvas");
          committedRef.current = snap;
        }
        const prev = document.createElement("canvas");
        prev.width = snap.width;
        prev.height = snap.height;
        const pctx = prev.getContext("2d");
        if (pctx && snap.width > 0) pctx.drawImage(snap, 0, 0);
        snap.width = pixelW;
        snap.height = pixelH;
        const sctx = snap.getContext("2d");
        if (sctx && prev.width > 0) {
          sctx.drawImage(prev, 0, 0);
        }
        paintFrame();
      }
    };

    const paintFrame = () => {
      const snap = committedRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (snap) ctx.drawImage(snap, 0, 0);
      const pts = pointsRef.current;
      if (pts.length > 0) {
        const outline = getStroke(
          pts,
          freehandStrokeOptions(!drawingRef.current, simulateRef.current),
        );
        ctx.fillStyle = INK;
        fillFreehandOutline(ctx, outline);
        writeHud(pts.length, outline.length, 0, 0);
      }
    };

    const writeHud = (
      pts: number,
      outline: number,
      frameMs: number,
      rafMs: number,
    ) => {
      const hud = hudRef.current;
      if (!hud) return;
      hud.textContent =
        `perfect-freehand\n` +
        `paints ${paintsRef.current}\n` +
        `frame ${frameMs.toFixed(1)}ms\n` +
        `raf ${rafMs.toFixed(1)}ms\n` +
        `pts ${pts}\n` +
        `outline ${outline}`;
    };

    const schedulePaint = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const now = performance.now();
        const prev = lastRafRef.current;
        lastRafRef.current = now;
        const t0 = performance.now();
        const pts = pointsRef.current;
        const snap = committedRef.current;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (snap) ctx.drawImage(snap, 0, 0);
        let outlineN = 0;
        if (pts.length > 0) {
          const outline = getStroke(
            pts,
            freehandStrokeOptions(false, simulateRef.current),
          );
          outlineN = outline.length;
          ctx.fillStyle = INK;
          fillFreehandOutline(ctx, outline);
        }
        paintsRef.current += 1;
        writeHud(
          pts.length,
          outlineN,
          performance.now() - t0,
          prev > 0 ? now - prev : 0,
        );
      });
    };

    const sampleOf = (event: PointerEvent): Sample => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (event.clientX - rect.left) * dpr;
      const y = (event.clientY - rect.top) * dpr;
      const pressure =
        event.pointerType === "pen" && Number.isFinite(event.pressure)
          ? event.pressure
          : 0.5;
      return [x, y, pressure];
    };

    const onDown = (event: PointerEvent) => {
      if (!active) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      drawingRef.current = true;
      simulateRef.current = event.pointerType !== "pen";
      pointsRef.current = [sampleOf(event)];
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* untrusted / already captured */
      }
      schedulePaint();
    };

    const onMove = (event: PointerEvent) => {
      if (!drawingRef.current) return;
      const coalesced = event.getCoalescedEvents?.();
      const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
      for (const item of batch) pointsRef.current.push(sampleOf(item));
      schedulePaint();
    };

    const onUp = (event: PointerEvent) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      pointsRef.current.push(sampleOf(event));
      const snap = committedRef.current;
      const sctx = snap?.getContext("2d");
      if (sctx && pointsRef.current.length > 0) {
        const outline = getStroke(
          pointsRef.current,
          freehandStrokeOptions(true, simulateRef.current),
        );
        sctx.fillStyle = INK;
        fillFreehandOutline(sctx, outline);
        writeHud(pointsRef.current.length, outline.length, 0, 0);
      }
      pointsRef.current = [];
      paintFrame();
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };

    sizeToHost();
    const ro = new ResizeObserver(() => sizeToHost());
    ro.observe(host);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  const clear = () => {
    const snap = committedRef.current;
    const canvas = canvasRef.current;
    if (snap) {
      const sctx = snap.getContext("2d");
      sctx?.clearRect(0, 0, snap.width, snap.height);
    }
    pointsRef.current = [];
    drawingRef.current = false;
    paintsRef.current = 0;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    const hud = hudRef.current;
    if (hud) {
      hud.textContent = "perfect-freehand\npaints 0\nframe 0.0ms\nraf 0.0ms\npts 0\noutline 0";
    }
  };

  return (
    <div className="lc-freehand-lab" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="lc-freehand-lab-canvas"
        aria-label="perfect-freehand pad"
        tabIndex={0}
      />
      <pre ref={hudRef} className="lc-freehand-lab-hud">
        {`perfect-freehand\npaints 0\nframe 0.0ms\nraf 0.0ms\npts 0\noutline 0`}
      </pre>
      <p className="lc-freehand-lab-note">
        Comparison pad. Outline from pointer samples each frame; lift freezes
        pixels. Not Speed Ink.
      </p>
      <button type="button" className="lc-freehand-lab-clear" onClick={clear}>
        Clear
      </button>
    </div>
  );
}
