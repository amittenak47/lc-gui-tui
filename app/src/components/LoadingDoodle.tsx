/**
 * Ephemeral pen doodle for loading / gate overlays.
 *
 * After {@link DOODLE_TTL_MS}, each stroke erases from its oldest tip (tail)
 * toward the newest — so ink disappears along the path instead of fading as
 * one blob.
 */

import { useEffect, useRef } from "react";

const DOODLE_TTL_MS = 8_000;
/** How long the tail-to-head erase takes after TTL. */
const ERASE_MS = 900;

interface Point {
  x: number;
  y: number;
  pressure: number;
}

interface Stroke {
  points: Point[];
  at: number;
}

export function LoadingDoodle({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<Point[] | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const paint = (now = performance.now()) => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = getComputedStyle(canvas).color || "currentColor";

      const kept: Stroke[] = [];
      for (const stroke of strokesRef.current) {
        const age = now - stroke.at;
        if (age >= DOODLE_TTL_MS + ERASE_MS) continue;
        let visible = stroke.points;
        if (age > DOODLE_TTL_MS && stroke.points.length > 1) {
          // Erase from the oldest tip (start of the stroke) toward the newest.
          const progress = Math.min(1, (age - DOODLE_TTL_MS) / ERASE_MS);
          const drop = Math.floor(progress * (stroke.points.length - 1));
          visible = stroke.points.slice(drop);
          if (visible.length < 2) continue;
        }
        drawStroke(ctx, visible);
        kept.push(stroke);
      }
      strokesRef.current = kept;
      if (strokeRef.current) drawStroke(ctx, strokeRef.current);
    };

    const loop = () => {
      paint();
      rafRef.current = requestAnimationFrame(loop);
    };

    const pointFrom = (event: PointerEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        pressure: event.pressure > 0 ? event.pressure : 0.5,
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== "pen") return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
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
      if (strokeRef.current.length > 1) {
        strokesRef.current.push({ points: strokeRef.current, at: performance.now() });
      }
      strokeRef.current = null;
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
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={["lc-loading-doodle", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    />
  );
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Point[]) {
  if (stroke.length === 0) return;
  for (let i = 1; i < stroke.length; i += 1) {
    const a = stroke[i - 1];
    const b = stroke[i];
    const pressure = (a.pressure + b.pressure) / 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = 1.6 + pressure * 3.4;
    ctx.globalAlpha = 0.55 + pressure * 0.35;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
