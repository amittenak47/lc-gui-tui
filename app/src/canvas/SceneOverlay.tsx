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
import { transitionViz } from "../viz/transition";
import { loadSceneImages } from "./sceneImages";

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
    const animationRef = useRef(0);
    const signatureRef = useRef("");
    const transitionRef = useRef<{ from: PaintSceneElement[]; to: PaintSceneElement[]; start: number } | null>(null);
    const displayedRef = useRef<PaintSceneElement[]>([]);
    const imagesRef = useRef<Record<string, CanvasImageSource>>({});
    const imageSignatureRef = useRef("");
    const imageGenerationRef = useRef(0);
    const reducedRef = useRef(false);
    const getElementsRef = useRef(getElements);
    getElementsRef.current = getElements;
    const getFilesRef = useRef(getFiles);
    getFilesRef.current = getFiles;
    const getViewportRef = useRef(getViewport);
    getViewportRef.current = getViewport;

    const redraw = useCallback(() => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = 0;
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
      const elements = getElementsRef.current() as PaintSceneElement[];
      const viz = elements.filter((el) => el.customData?.lcVizId);
      const signature = JSON.stringify(viz);
      const now = performance.now();
      if (signature !== signatureRef.current) {
        transitionRef.current = displayedRef.current.length && viz.length && !reducedRef.current
          ? { from: displayedRef.current, to: viz, start: now }
          : null;
        signatureRef.current = signature;
      }
      const transition = transitionRef.current;
      const progress = transition ? Math.min(1, (now - transition.start) / 260) : 1;
      const presented = transition && !reducedRef.current ? transitionViz(transition.from, transition.to, progress) : viz;
      displayedRef.current = presented;
      if (progress >= 1 || reducedRef.current) transitionRef.current = null;

      const files = getFilesRef.current?.() ?? {};
      const imageSignature = JSON.stringify(elements.filter((el) => el.type === "image" && !el.isDeleted)
        .map((el) => [el.fileId, el.fileId ? files[el.fileId]?.dataURL : null]));
      if (imageSignature !== imageSignatureRef.current) {
        imageSignatureRef.current = imageSignature;
        const generation = ++imageGenerationRef.current;
        void loadSceneImages(elements, files).then((images) => {
          if (generation !== imageGenerationRef.current) return;
          imagesRef.current = images;
          redraw();
        });
      }
      const bounds = applyViewportTransform(ctx, view, dpr);
      paintSceneElements(ctx, [...elements.filter((el) => !el.customData?.lcVizId), ...presented], {
        images: imagesRef.current,
        view: bounds,
      });
      if (transitionRef.current) animationRef.current = requestAnimationFrame(redraw);
    }, []);

    useImperativeHandle(ref, () => ({ redraw }), [redraw]);

    useEffect(() => {
      const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
      reducedRef.current = media?.matches ?? false;
      const onMotion = () => { reducedRef.current = media?.matches ?? false; redraw(); };
      media?.addEventListener("change", onMotion);
      redraw();
      const host = hostRef.current;
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => redraw()) : null;
      if (host) observer?.observe(host);
      return () => {
        observer?.disconnect();
        media?.removeEventListener("change", onMotion);
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
        imageGenerationRef.current++;
      };
    }, [redraw]);

    return (
      <div ref={hostRef} className="lc-scene-overlay" aria-hidden>
        <canvas ref={canvasRef} className="lc-scene-overlay-canvas" />
      </div>
    );
  },
);
