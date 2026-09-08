/**
 * Camera-aligned overlay that paints scene primitives above the ink pad.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

import {
  applyViewportTransform,
  paintSceneElements,
  type PaintSceneElement,
  type PaintSceneFile,
} from "./paintScene";
import type { ViewportTransform } from "./rasterInk";

export interface SceneOverlayHandle {
  redraw(): void;
}

export interface SceneOverlayProps {
  getElements: () => readonly unknown[];
  getFiles?: () => Record<string, PaintSceneFile | undefined>;
  getViewport: () => ViewportTransform | null;
}

export const SceneOverlay = forwardRef<SceneOverlayHandle, SceneOverlayProps>(
  function SceneOverlay({ getElements, getFiles, getViewport }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const getElementsRef = useRef(getElements);
    getElementsRef.current = getElements;
    const getFilesRef = useRef(getFiles);
    getFilesRef.current = getFiles;
    const getViewportRef = useRef(getViewport);
    getViewportRef.current = getViewport;

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      if (!canvas || !host) return;
      const view = getViewportRef.current();
      const cssW = Math.max(1, view?.width || host.clientWidth || 1);
      const cssH = Math.max(1, view?.height || host.clientHeight || 1);
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const pxW = Math.max(1, Math.round(cssW * dpr));
      const pxH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== pxW) canvas.width = pxW;
      if (canvas.height !== pxH) canvas.height = pxH;
      if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`;
      if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!view) return;
      const bounds = applyViewportTransform(ctx, view, dpr);
      paintSceneElements(ctx, getElementsRef.current() as PaintSceneElement[], {
        files: getFilesRef.current?.(),
        view: bounds,
      });
    }, []);

    useImperativeHandle(ref, () => ({ redraw }), [redraw]);

    useEffect(() => {
      redraw();
      const host = hostRef.current;
      if (!host || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => redraw());
      observer.observe(host);
      return () => observer.disconnect();
    }, [redraw]);

    return (
      <div ref={hostRef} className="lc-scene-overlay" aria-hidden>
        <canvas ref={canvasRef} className="lc-scene-overlay-canvas" />
      </div>
    );
  },
);
