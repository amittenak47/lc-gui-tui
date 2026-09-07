/**
 * Comparison pad for the WebGL overlay pen. Not Speed Ink, not the board.
 *
 * Revision-only tab on `freehand-revision`. Revert the commit that added
 * `inklab` (this file, home card, tab kind) before merging to freehand-stage.
 *
 * Layout: one host, one visible canvas, one snap, HUD, Clear.
 * Host talks only to `createInkLabEngine`.
 */

import { useEffect, useRef } from "react";

import {
  createInkLabEngine,
  type InkLabSample,
} from "../canvas/inkLab/engine";
import {
  createInkLabHudStats,
  formatInkLabHud,
  INK_LAB_HUD_ZERO,
} from "../canvas/inkLab/hud";
import { drawFrameSpark } from "../canvas/inkLab/hudSpark";

export interface InkLabProps {
  active: boolean;
}

export type { InkLabHud } from "../canvas/inkLab/hud";
export { formatInkLabHud, INK_LAB_HUD_ZERO } from "../canvas/inkLab/hud";

function sampleOf(canvas: HTMLCanvasElement, event: PointerEvent): InkLabSample {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (event.clientX - rect.left) * dpr;
  const y = (event.clientY - rect.top) * dpr;
  const pressure =
    event.pointerType === "pen" && Number.isFinite(event.pressure)
      ? event.pressure
      : 0.5;
  return { x, y, p: pressure, t: event.timeStamp };
}

export function InkLab({ active }: InkLabProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLPreElement | null>(null);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<ReturnType<typeof createInkLabEngine> | null>(null);
  const backendRef = useRef("none");
  const paintsRef = useRef(0);
  const lastRafRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const bakeRef = useRef({ bakeMs: 0, bake: "catmull" });
  const drawingRef = useRef(false);
  const hudStatsRef = useRef(createInkLabHudStats());

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const writeHud = (
      stats: {
        frameMs: number;
        pts: number;
        segs: number;
        ekfMs: number;
        drawMs: number;
        hold: boolean;
        suffix?: boolean;
        backend?: string;
      },
      rafMs: number,
    ) => {
      const hud = hudRef.current;
      if (!hud) return;
      const ranges = hudStatsRef.current.snapshot();
      hud.textContent = formatInkLabHud({
        backend: stats.backend ?? backendRef.current,
        paints: paintsRef.current,
        frameMs: stats.frameMs,
        rafMs,
        pts: stats.pts,
        segs: stats.segs,
        ekfMs: stats.ekfMs,
        drawMs: stats.drawMs,
        hold: stats.hold,
        suffix: stats.suffix ?? true,
        bakeMs: bakeRef.current.bakeMs,
        bake: bakeRef.current.bake,
        ...ranges,
      });
      const spark = sparkRef.current;
      if (spark) drawFrameSpark(spark, ranges.spark ?? []);
    };

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
        engineRef.current?.paint();
      }
    };

    sizeToHost();
    const engine = createInkLabEngine();
    engineRef.current = engine;
    const backend = engine.attach(canvas);
    backendRef.current = backend;
    writeHud(
      { frameMs: 0, pts: 0, segs: 0, ekfMs: 0, drawMs: 0, hold: false },
      0,
    );

    const schedulePaint = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const now = performance.now();
        const prev = lastRafRef.current;
        lastRafRef.current = now;
        const stats = engine.paint();
        paintsRef.current += 1;
        const rafMs = prev > 0 ? now - prev : 0;
        hudStatsRef.current.sample(stats.frameMs, rafMs, stats.drawMs, stats.ekfMs);
        writeHud(stats, rafMs);
        if (drawingRef.current && stats.hold) schedulePaint();
      });
    };

    const onDown = (event: PointerEvent) => {
      if (!active) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      engine.down(sampleOf(canvas, event));
      drawingRef.current = true;
      lastRafRef.current = 0;
      hudStatsRef.current.reset();
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
      engine.move(batch.map((item) => sampleOf(canvas, item)));
      schedulePaint();
    };

    const onUp = (event: PointerEvent) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      bakeRef.current = engine.up(sampleOf(canvas, event));
      const stats = engine.paint();
      paintsRef.current += 1;
      hudStatsRef.current.sample(stats.frameMs, 0, stats.drawMs, stats.ekfMs);
      writeHud(stats, 0);
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };

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
      engine.destroy();
      engineRef.current = null;
    };
  }, [active]);

  const clear = () => {
    engineRef.current?.clear();
    paintsRef.current = 0;
    bakeRef.current = { bakeMs: 0, bake: "catmull" };
    hudStatsRef.current.reset();
    const hud = hudRef.current;
    if (hud) {
      hud.textContent = formatInkLabHud({
        ...INK_LAB_HUD_ZERO,
        backend: backendRef.current,
      });
    }
    const spark = sparkRef.current;
    if (spark) drawFrameSpark(spark, []);
  };

  return (
    <div className="lc-ink-lab" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="lc-ink-lab-canvas"
        aria-label="Ink lab pad"
        tabIndex={0}
      />
      <div className="lc-ink-perf-stack">
        <pre ref={hudRef} className="lc-ink-lab-hud">
          {formatInkLabHud(INK_LAB_HUD_ZERO)}
        </pre>
        <canvas
          ref={sparkRef}
          className="lc-ink-lab-spark"
          width={168}
          height={36}
          aria-hidden="true"
        />
      </div>
      <p className="lc-ink-lab-note">
        Comparison pad. WebGL overlay pen. Not Speed Ink. Not the whiteboard.
      </p>
      <button type="button" className="lc-ink-lab-clear" onClick={clear}>
        Clear
      </button>
    </div>
  );
}
