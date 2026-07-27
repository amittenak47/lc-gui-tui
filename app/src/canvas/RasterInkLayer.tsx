/**
 * Bitmap ink layer over Excalidraw — pen draws pixels; eraser clears them.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import {
  eraserSceneRadius,
  inkLineWidth,
  paintRasterInk,
  scenePointFromPointer,
  stampAlongSegment,
  type InkOp,
  type ViewportTransform,
} from "./rasterInk";

export interface RasterInkHandle {
  clear(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  /** True once anything has been painted or erased on this layer. */
  hasInk(): boolean;
  repaint(): void;
}

export interface RasterInkLayerProps {
  enabled: boolean;
  tool: "pen" | "eraser" | null;
  strokeWidth: number;
  inkColor: string;
  pressureSensitive: boolean;
  getViewport: () => ViewportTransform | null;
  onChange?: () => void;
}

export const RasterInkLayer = forwardRef<RasterInkHandle, RasterInkLayerProps>(
  function RasterInkLayer(
    { enabled, tool, strokeWidth, inkColor, pressureSensitive, getViewport, onChange },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const opsRef = useRef<InkOp[]>([]);
    const undoRef = useRef<InkOp[][]>([]);
    const redoRef = useRef<InkOp[][]>([]);
    const liveRef = useRef<InkOp | null>(null);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<ReturnType<typeof scenePointFromPointer> | null>(null);

    const alignToExcalidraw = useCallback((canvas: HTMLCanvasElement) => {
      const board = canvas.parentElement;
      if (!board) return null;
      const excal = board.querySelector("canvas.excalidraw__canvas");
      if (!(excal instanceof HTMLCanvasElement)) return null;
      const boardRect = board.getBoundingClientRect();
      const excalRect = excal.getBoundingClientRect();
      canvas.style.left = `${excalRect.left - boardRect.left}px`;
      canvas.style.top = `${excalRect.top - boardRect.top}px`;
      canvas.style.width = `${excalRect.width}px`;
      canvas.style.height = `${excalRect.height}px`;
      return excalRect;
    }, []);

    const repaint = useCallback(() => {
      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      const excalRect = alignToExcalidraw(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = excalRect?.width ?? viewport.width;
      const cssH = excalRect?.height ?? viewport.height;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      paintRasterInk(ctx, viewport, opsRef.current, liveRef.current, dpr);
    }, [alignToExcalidraw, getViewport]);

    const commitLive = useCallback(() => {
      const live = liveRef.current;
      if (!live) return;
      undoRef.current.push(
        opsRef.current.map((op) =>
          op.kind === "draw"
            ? { ...op, points: [...op.points] }
            : { ...op, points: [...op.points] },
        ),
      );
      redoRef.current = [];
      opsRef.current = [...opsRef.current, live];
      liveRef.current = null;
      lastPointRef.current = null;
      repaint();
      onChange?.();
    }, [onChange, repaint]);

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          if (opsRef.current.length === 0) return;
          undoRef.current.push(
        opsRef.current.map((op) =>
          op.kind === "draw"
            ? { ...op, points: [...op.points] }
            : { ...op, points: [...op.points] },
        ),
      );
          redoRef.current = [];
          opsRef.current = [];
          liveRef.current = null;
          repaint();
          onChange?.();
        },
        undo() {
          if (undoRef.current.length === 0) return false;
          redoRef.current.push(opsRef.current.map((op) => ({ ...op, points: [...op.points] })));
          opsRef.current = undoRef.current.pop() ?? [];
          liveRef.current = null;
          repaint();
          onChange?.();
          return true;
        },
        redo() {
          if (redoRef.current.length === 0) return false;
          undoRef.current.push(
        opsRef.current.map((op) =>
          op.kind === "draw"
            ? { ...op, points: [...op.points] }
            : { ...op, points: [...op.points] },
        ),
      );
          opsRef.current = redoRef.current.pop() ?? [];
          liveRef.current = null;
          repaint();
          onChange?.();
          return true;
        },
        canUndo() {
          return undoRef.current.length > 0 || opsRef.current.length > 0;
        },
        hasInk() {
          // An erase-only history still counts as "they drew something": the
          // pixels are gone but the board is not the untouched one we seeded.
          return opsRef.current.length > 0;
        },
        repaint,
      }),
      [onChange, repaint],
    );

    useEffect(() => {
      repaint();
    }, [enabled, strokeWidth, inkColor, pressureSensitive, repaint]);

    useEffect(() => {
      if (!enabled) return;
      const onResize = () => repaint();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [enabled, repaint]);

    useEffect(() => {
      if (!enabled || !tool) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const begin = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const viewport = getViewport();
        if (!viewport || !isCanvasTarget(event.target, canvas)) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        drawingRef.current = true;
        const rect = canvas.getBoundingClientRect();
        const point = scenePointFromPointer(
          event.clientX,
          event.clientY,
          rect,
          viewport,
          event.pressure,
        );
        lastPointRef.current = point;
        if (tool === "pen") {
          liveRef.current = {
            kind: "draw",
            color: inkColor,
            baseWidth: strokeWidth,
            pressureSensitive,
            points: [point],
          };
        } else {
          liveRef.current = {
            kind: "erase",
            radius: eraserSceneRadius(strokeWidth),
            points: [point],
          };
        }
        repaint();
      };

      const move = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        const viewport = getViewport();
        if (!viewport) return;
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const point = scenePointFromPointer(
          event.clientX,
          event.clientY,
          rect,
          viewport,
          event.pressure,
        );
        const live = liveRef.current;
        const last = lastPointRef.current;
        if (!live || !last) return;

        const step =
          live.kind === "erase"
            ? Math.max(live.radius * 0.45, 0.5)
            : Math.max(
                inkLineWidth(
                  strokeWidth,
                  point.pressure,
                  live.kind === "draw" ? live.pressureSensitive : false,
                ) * 0.35,
                0.5,
              );
        const stamps = stampAlongSegment(last, point, step);
        live.points.push(...stamps);
        lastPointRef.current = point;
        repaint();
      };

      const end = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        commitLive();
      };

      canvas.addEventListener("pointerdown", begin, true);
      canvas.addEventListener("pointermove", move, true);
      canvas.addEventListener("pointerup", end, true);
      canvas.addEventListener("pointercancel", end, true);
      return () => {
        canvas.removeEventListener("pointerdown", begin, true);
        canvas.removeEventListener("pointermove", move, true);
        canvas.removeEventListener("pointerup", end, true);
        canvas.removeEventListener("pointercancel", end, true);
      };
    }, [commitLive, enabled, getViewport, inkColor, pressureSensitive, repaint, strokeWidth, tool]);

    if (!enabled) return null;

    return (
      <canvas
        ref={canvasRef}
        className={
          tool === "eraser"
            ? "lc-raster-ink lc-raster-ink-eraser"
            : tool === "pen"
              ? "lc-raster-ink lc-raster-ink-pen"
              : "lc-raster-ink"
        }
        style={{ pointerEvents: tool ? "auto" : "none" }}
        aria-hidden
      />
    );
  },
);

function isCanvasTarget(target: EventTarget | null, layer: HTMLCanvasElement): boolean {
  return target === layer;
}
