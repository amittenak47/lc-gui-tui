/**
 * Bitmap ink layer over Excalidraw — pen draws pixels; eraser clears them.
 *
 * Committed ink is baked into an offscreen canvas. Live strokes paint on top of
 * that bake. Without baking, every pointer move replayed every erase stamp from
 * history (dense destination-out arcs), so a one-character erase made later
 * pen strokes feel like a leak.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import {
  applyInkOp,
  applyInkOpFrom,
  eraserSceneRadius,
  inkBakeKey,
  inkLineWidth,
  paintRasterInk,
  scenePointFromPointer,
  setInkSceneTransform,
  stampAlongSegment,
  type InkOp,
  type SceneBounds,
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
  /**
   * Committed ops, for the recognizer and the PNG export. The in-progress op is
   * left out — the pen is still down, so there is no stroke to read yet.
   */
  getOps(): InkOp[];
  /** Replace committed ink (notebook restore). Clears undo/redo. */
  setOps(ops: readonly InkOp[]): void;
}

export interface RasterInkLayerProps {
  enabled: boolean;
  tool: "pen" | "eraser" | null;
  strokeWidth: number;
  inkColor: string;
  pressureSensitive: boolean;
  getViewport: () => ViewportTransform | null;
  /**
   * Scene box the ink is allowed to show inside — the open page on a tablet,
   * `null` on the desktop's single stacked canvas.
   */
  clip?: SceneBounds | null;
  onChange?: () => void;
  /**
   * Stylus barrel / eraser tip: toggle pen↔eraser. Return true if handled so
   * the stroke is not started.
   */
  onStylusAccessory?: (event: PointerEvent) => boolean;
}

function cloneOps(ops: readonly InkOp[]): InkOp[] {
  return ops.map((op) => ({ ...op, points: [...op.points] }));
}

export const RasterInkLayer = forwardRef<RasterInkHandle, RasterInkLayerProps>(
  function RasterInkLayer(
    {
      enabled,
      tool,
      strokeWidth,
      inkColor,
      pressureSensitive,
      getViewport,
      clip = null,
      onChange,
      onStylusAccessory,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const bakeRef = useRef<HTMLCanvasElement | null>(null);
    const bakeKeyRef = useRef<string>("");
    const opsRef = useRef<InkOp[]>([]);
    const undoRef = useRef<InkOp[][]>([]);
    const redoRef = useRef<InkOp[][]>([]);
    const liveRef = useRef<InkOp | null>(null);
    /** Next fromIndex for {@link applyInkOpFrom} — advances as live ink is painted. */
    const liveDrawnIndexRef = useRef(0);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<ReturnType<typeof scenePointFromPointer> | null>(null);
    // Read through a ref so a page turn doesn't rebuild `repaint` and with it
    // every pointer listener on the layer.
    const clipRef = useRef<SceneBounds | null>(clip);
    clipRef.current = clip;

    // Keep the hot pointer path off React effect deps — rebinding mid-stroke
    // drops pointer capture and cuts ink short.
    const getViewportRef = useRef(getViewport);
    getViewportRef.current = getViewport;
    const onStylusAccessoryRef = useRef(onStylusAccessory);
    onStylusAccessoryRef.current = onStylusAccessory;
    const inkColorRef = useRef(inkColor);
    inkColorRef.current = inkColor;
    const strokeWidthRef = useRef(strokeWidth);
    strokeWidthRef.current = strokeWidth;
    const pressureSensitiveRef = useRef(pressureSensitive);
    pressureSensitiveRef.current = pressureSensitive;

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

    const rebuildBake = useCallback(
      (
        viewport: ViewportTransform,
        dpr: number,
        cssW: number,
        cssH: number,
        key: string,
      ) => {
        let bake = bakeRef.current;
        if (!bake) {
          bake = document.createElement("canvas");
          bakeRef.current = bake;
        }
        const pixelW = Math.max(1, Math.round(cssW * dpr));
        const pixelH = Math.max(1, Math.round(cssH * dpr));
        if (bake.width !== pixelW || bake.height !== pixelH) {
          bake.width = pixelW;
          bake.height = pixelH;
        }
        const bakeCtx = bake.getContext("2d");
        if (!bakeCtx) return null;
        // paintRasterInk uses viewport.width/height for the clear — keep those
        // aligned with the CSS box we sized the bake to.
        const bakeViewport: ViewportTransform = {
          ...viewport,
          width: cssW,
          height: cssH,
        };
        paintRasterInk(bakeCtx, bakeViewport, opsRef.current, null, dpr, clipRef.current);
        bakeKeyRef.current = key;
        return bake;
      },
      [],
    );

    const ensureBake = useCallback(
      (viewport: ViewportTransform, dpr: number, cssW: number, cssH: number) => {
        const key = inkBakeKey(viewport, dpr, cssW, cssH, clipRef.current);
        if (bakeRef.current && bakeKeyRef.current === key) {
          return bakeRef.current;
        }
        return rebuildBake(viewport, dpr, cssW, cssH, key);
      },
      [rebuildBake],
    );

    /** Append a just-committed op onto the bake without replaying history. */
    const stampOntoBake = useCallback(
      (op: InkOp, viewport: ViewportTransform, dpr: number, cssW: number, cssH: number) => {
        const key = inkBakeKey(viewport, dpr, cssW, cssH, clipRef.current);
        // Bake already rebuilt from ops that include this op — do not stamp again.
        if (!bakeRef.current || bakeKeyRef.current !== key) {
          rebuildBake(viewport, dpr, cssW, cssH, key);
          return;
        }
        const bake = bakeRef.current;
        const bakeCtx = bake.getContext("2d");
        if (!bakeCtx) return;
        setInkSceneTransform(bakeCtx, viewport, dpr);
        const clipBox = clipRef.current;
        if (clipBox) {
          bakeCtx.save();
          bakeCtx.beginPath();
          bakeCtx.rect(
            clipBox.minX,
            clipBox.minY,
            clipBox.maxX - clipBox.minX,
            clipBox.maxY - clipBox.minY,
          );
          bakeCtx.clip();
          applyInkOp(bakeCtx, op);
          bakeCtx.restore();
        } else {
          applyInkOp(bakeCtx, op);
        }
      },
      [rebuildBake],
    );

    const invalidateBake = useCallback(() => {
      bakeKeyRef.current = "";
    }, []);

    /** Full rebuild: clear, blit bake, replay entire live op. Used on pan/zoom/undo. */
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
      const pixelW = Math.round(cssW * dpr);
      const pixelH = Math.round(cssH * dpr);
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }

      const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };
      const bake = ensureBake(view, dpr, cssW, cssH);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (bake) {
        ctx.drawImage(bake, 0, 0);
      }

      const live = liveRef.current;
      if (live) {
        setInkSceneTransform(ctx, view, dpr);
        const clipBox = clipRef.current;
        if (clipBox) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(
            clipBox.minX,
            clipBox.minY,
            clipBox.maxX - clipBox.minX,
            clipBox.maxY - clipBox.minY,
          );
          ctx.clip();
          applyInkOp(ctx, live);
          ctx.restore();
        } else {
          applyInkOp(ctx, live);
        }
        liveDrawnIndexRef.current =
          live.kind === "draw" ? Math.max(0, live.points.length - 1) : live.points.length;
      } else {
        liveDrawnIndexRef.current = 0;
      }
    }, [alignToExcalidraw, ensureBake, getViewport]);

    /**
     * Hot path: paint only new live segments/stamps without clearing or
     * re-blitting the bake. Falls back to full repaint if the view changed.
     */
    const paintLiveIncremental = useCallback(() => {
      const canvas = canvasRef.current;
      const viewport = getViewport();
      const live = liveRef.current;
      if (!canvas || !viewport || !live || viewport.width < 1 || viewport.height < 1) return;
      const excalRect = alignToExcalidraw(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = excalRect?.width ?? viewport.width;
      const cssH = excalRect?.height ?? viewport.height;
      const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };
      const key = inkBakeKey(view, dpr, cssW, cssH, clipRef.current);
      // View/clip/size change — bake is stale; must clear + rebuild.
      if (
        !bakeRef.current ||
        bakeKeyRef.current !== key ||
        canvas.width !== Math.round(cssW * dpr) ||
        canvas.height !== Math.round(cssH * dpr)
      ) {
        repaint();
        return;
      }

      setInkSceneTransform(ctx, view, dpr);
      const clipBox = clipRef.current;
      const from = liveDrawnIndexRef.current;
      if (clipBox) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          clipBox.minX,
          clipBox.minY,
          clipBox.maxX - clipBox.minX,
          clipBox.maxY - clipBox.minY,
        );
        ctx.clip();
        liveDrawnIndexRef.current = applyInkOpFrom(ctx, live, from);
        ctx.restore();
      } else {
        liveDrawnIndexRef.current = applyInkOpFrom(ctx, live, from);
      }
    }, [alignToExcalidraw, getViewport, repaint]);

    const commitLive = useCallback(() => {
      const live = liveRef.current;
      if (!live) return;
      undoRef.current.push(cloneOps(opsRef.current));
      // Cap undo depth — each snapshot clones every point, and erase stamps are dense.
      if (undoRef.current.length > 40) {
        undoRef.current.splice(0, undoRef.current.length - 40);
      }
      redoRef.current = [];
      opsRef.current = [...opsRef.current, live];
      liveRef.current = null;
      liveDrawnIndexRef.current = 0;
      lastPointRef.current = null;

      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (canvas && viewport) {
        const excalRect = alignToExcalidraw(canvas);
        const dpr = window.devicePixelRatio || 1;
        const cssW = excalRect?.width ?? viewport.width;
        const cssH = excalRect?.height ?? viewport.height;
        const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };
        stampOntoBake(live, view, dpr, cssW, cssH);
      } else {
        invalidateBake();
      }
      repaint();
      onChange?.();
    }, [alignToExcalidraw, getViewport, invalidateBake, onChange, repaint, stampOntoBake]);

    const paintLiveIncrementalRef = useRef(paintLiveIncremental);
    paintLiveIncrementalRef.current = paintLiveIncremental;
    const repaintRef = useRef(repaint);
    repaintRef.current = repaint;
    const commitLiveRef = useRef(commitLive);
    commitLiveRef.current = commitLive;

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          if (opsRef.current.length === 0) return;
          undoRef.current.push(cloneOps(opsRef.current));
          redoRef.current = [];
          opsRef.current = [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateBake();
          repaint();
          onChange?.();
        },
        undo() {
          if (undoRef.current.length === 0) return false;
          redoRef.current.push(cloneOps(opsRef.current));
          opsRef.current = undoRef.current.pop() ?? [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateBake();
          repaint();
          onChange?.();
          return true;
        },
        redo() {
          if (redoRef.current.length === 0) return false;
          undoRef.current.push(cloneOps(opsRef.current));
          opsRef.current = redoRef.current.pop() ?? [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateBake();
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
        getOps() {
          return [...opsRef.current];
        },
        setOps(ops) {
          opsRef.current = cloneOps(ops);
          undoRef.current = [];
          redoRef.current = [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateBake();
          repaint();
        },
        repaint,
      }),
      [invalidateBake, onChange, repaint],
    );

    useEffect(() => {
      invalidateBake();
      repaint();
    }, [enabled, clip, invalidateBake, repaint]);

    useEffect(() => {
      if (!enabled) return;
      const onResize = () => {
        invalidateBake();
        repaint();
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [enabled, invalidateBake, repaint]);

    useEffect(() => {
      if (!enabled || !tool) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const begin = (event: PointerEvent) => {
        if (onStylusAccessoryRef.current?.(event)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // Primary tip only for drawing. Barrel / eraser tip are accessory.
        if (event.button !== 0) return;
        const viewport = getViewportRef.current();
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
        const width = strokeWidthRef.current;
        if (tool === "pen") {
          liveRef.current = {
            kind: "draw",
            color: inkColorRef.current,
            baseWidth: width,
            pressureSensitive: pressureSensitiveRef.current,
            points: [point],
          };
          liveDrawnIndexRef.current = 0;
        } else {
          liveRef.current = {
            kind: "erase",
            radius: eraserSceneRadius(width),
            points: [point],
          };
          liveDrawnIndexRef.current = 0;
        }
        // One full blit so the bake is under the first stamp/segment.
        repaintRef.current();
      };

      const move = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        const viewport = getViewportRef.current();
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

        const width = strokeWidthRef.current;
        const step =
          live.kind === "erase"
            ? Math.max(live.radius * 0.45, 0.5)
            : Math.max(
                inkLineWidth(
                  width,
                  point.pressure,
                  live.kind === "draw" ? live.pressureSensitive : false,
                ) * 0.35,
                0.5,
              );
        const stamps = stampAlongSegment(last, point, step);
        live.points.push(...stamps);
        lastPointRef.current = point;
        paintLiveIncrementalRef.current();
      };

      const end = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        commitLiveRef.current();
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
      // Intentionally omit paint/callback deps — read via refs so a Board
      // re-render (chrome dismiss) never tears down capture mid-stroke.
    }, [enabled, tool]);

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
