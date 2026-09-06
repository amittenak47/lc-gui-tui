/**
 * Comparison pad for the WebGL overlay pen. Not Speed Ink, not the board.
 *
 * Layout matches FreehandLab: one host, one visible canvas, one snap, HUD,
 * Clear. Host talks only to `createInkLabEngine`.
 */

import { useEffect, useRef } from "react";

import { createInkLabEngine } from "../canvas/inkLab/engine";

export interface InkLabProps {
  active: boolean;
}

export type InkLabHud = {
  backend: string;
  paints: number;
  frameMs: number;
  rafMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
  bakeMs: number;
  bake: string;
};

export const INK_LAB_HUD_ZERO: InkLabHud = {
  backend: "none",
  paints: 0,
  frameMs: 0,
  rafMs: 0,
  pts: 0,
  segs: 0,
  ekfMs: 0,
  drawMs: 0,
  hold: false,
  bakeMs: 0,
  bake: "catmull",
};

export function formatInkLabHud(hud: InkLabHud): string {
  return (
    `ink lab\n` +
    `backend ${hud.backend}\n` +
    `paints ${hud.paints}\n` +
    `frame ${hud.frameMs.toFixed(1)}ms\n` +
    `raf ${hud.rafMs.toFixed(1)}ms\n` +
    `pts ${hud.pts}\n` +
    `segs ${hud.segs}\n` +
    `ekf ${hud.ekfMs.toFixed(2)}ms\n` +
    `draw ${hud.drawMs.toFixed(2)}ms\n` +
    `hold ${hud.hold ? "yes" : "no"}\n` +
    `bake ${hud.bakeMs.toFixed(1)}ms ${hud.bake}`
  );
}

export function InkLab({ active }: InkLabProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLPreElement | null>(null);
  const engineRef = useRef<ReturnType<typeof createInkLabEngine> | null>(null);
  const backendRef = useRef("none");

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

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
      }
    };

    const engine = createInkLabEngine();
    engineRef.current = engine;
    const backend = engine.attach(canvas);
    backendRef.current = backend;
    const hud = hudRef.current;
    if (hud) {
      hud.textContent = formatInkLabHud({ ...INK_LAB_HUD_ZERO, backend });
    }

    sizeToHost();
    const ro = new ResizeObserver(() => sizeToHost());
    ro.observe(host);
    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [active]);

  const clear = () => {
    engineRef.current?.clear();
    const hud = hudRef.current;
    if (hud) {
      hud.textContent = formatInkLabHud({
        ...INK_LAB_HUD_ZERO,
        backend: backendRef.current,
      });
    }
  };

  return (
    <div className="lc-ink-lab" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="lc-ink-lab-canvas"
        aria-label="Ink lab pad"
        tabIndex={0}
      />
      <pre ref={hudRef} className="lc-ink-lab-hud">
        {formatInkLabHud(INK_LAB_HUD_ZERO)}
      </pre>
      <p className="lc-ink-lab-note">
        Comparison pad. WebGL overlay pen. Not Speed Ink. Not the whiteboard.
      </p>
      <button type="button" className="lc-ink-lab-clear" onClick={clear}>
        Clear
      </button>
    </div>
  );
}
