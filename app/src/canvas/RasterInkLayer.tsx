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
  hasStylusPressure,
  inkBakeKey,
  inkStrokeStyle,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  NO_PRESSURE,
  paintRasterInk,
  scenePointFromPointer,
  setInkSceneTransform,
  smoothPressure,
  stampAlongSegment,
  type InkOp,
  type SceneBounds,
  type ViewportTransform,
} from "./rasterInk";
import { inkMetrics } from "./inkMetrics";

export interface RasterInkHandle {
  clear(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  /** True once anything has been painted or erased on this layer. */
  hasInk(): boolean;
  /** Pen/eraser tip is down — skip camera/repaint work that would cut the stroke. */
  isDrawing(): boolean;
  repaint(): void;
  /**
   * Cheap camera sync during pan — CSS-translate the baked bitmap when only
   * scroll changed; rebuild when zoom/size/clip changed.
   */
  syncCamera(): void;
  /** End of pan/inertia — clear translate and rebuild bake at current scroll. */
  commitCamera(): void;
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
  inkFullness: number;
  pressureClip: number;
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
      inkFullness,
      pressureClip,
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
    /** Viewport the current bake was rasterised at — scroll may lag via CSS translate. */
    const bakeViewportRef = useRef<ViewportTransform | null>(null);
    const opsRef = useRef<InkOp[]>([]);
    const undoRef = useRef<InkOp[][]>([]);
    const redoRef = useRef<InkOp[][]>([]);
    const liveRef = useRef<InkOp | null>(null);
    /** Next fromIndex for {@link applyInkOpFrom} — advances as live ink is painted. */
    const liveDrawnIndexRef = useRef(0);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<ReturnType<typeof scenePointFromPointer> | null>(null);
    /** Running EMA of raw stylus pressure for the live stroke — see smoothPressure. */
    const smoothedPressureRef = useRef(0);
    /**
     * Viewport + CSS box frozen at pointerdown for the whole stroke.
     *
     * Mid-stroke scroll/zoom used to change `inkBakeKey` and force a full
     * `repaint()` on every move — that hitch is what cuts a letter like "g"
     * short. Keep mapping and incremental paint on the stroke-start frame.
     */
    const strokeViewRef = useRef<ViewportTransform | null>(null);
    const strokeBoxRef = useRef<{ width: number; height: number } | null>(null);
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
    const inkFullnessRef = useRef(inkFullness);
    inkFullnessRef.current = inkFullness;
    const pressureClipRef = useRef(pressureClip);
    pressureClipRef.current = pressureClip;
    const pressureSensitiveRef = useRef(pressureSensitive);
    pressureSensitiveRef.current = pressureSensitive;
    const toolRef = useRef(tool);
    toolRef.current = tool;

    /**
     * Sit exactly on the Excalidraw canvas, on whole device pixels.
     *
     * The rects are fractional, and a CSS box whose width is not a whole number
     * of device pixels makes the browser resample the backing store — every
     * stamp lands a fraction of a pixel off and the whole layer reads soft. The
     * ink is a bitmap, not vectors, so there is no re-render that would sharpen
     * it back up. Snap the box to the pixel grid and the mapping is 1:1.
     */
    const alignToExcalidraw = useCallback((canvas: HTMLCanvasElement) => {
      const board = canvas.parentElement;
      if (!board) return null;
      const excal = board.querySelector("canvas.excalidraw__canvas");
      if (!(excal instanceof HTMLCanvasElement)) return null;
      const dpr = window.devicePixelRatio || 1;
      const snap = (value: number) => Math.round(value * dpr) / dpr;
      const boardRect = board.getBoundingClientRect();
      const excalRect = excal.getBoundingClientRect();
      const width = snap(excalRect.width);
      const height = snap(excalRect.height);
      canvas.style.left = `${snap(excalRect.left - boardRect.left)}px`;
      canvas.style.top = `${snap(excalRect.top - boardRect.top)}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      return { width, height };
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
        bakeViewportRef.current = { ...bakeViewport };
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
      bakeViewportRef.current = null;
    }, []);

    const blitBakeToCanvas = useCallback(
      (view: ViewportTransform, cssW: number, cssH: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const pixelW = Math.round(cssW * dpr);
        const pixelH = Math.round(cssH * dpr);
        if (canvas.width !== pixelW || canvas.height !== pixelH) {
          canvas.width = pixelW;
          canvas.height = pixelH;
          canvas.style.width = `${pixelW / dpr}px`;
          canvas.style.height = `${pixelH / dpr}px`;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const bake = bakeRef.current;
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
      },
      [],
    );

    const commitCamera = useCallback(() => {
      if (drawingRef.current) return;
      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      canvas.style.transform = "";
      const excalRect = alignToExcalidraw(canvas);
      const dpr = window.devicePixelRatio || 1;
      const cssW = excalRect?.width ?? viewport.width;
      const cssH = excalRect?.height ?? viewport.height;
      const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };
      const key = inkBakeKey(view, dpr, cssW, cssH, clipRef.current);
      rebuildBake(view, dpr, cssW, cssH, key);
      blitBakeToCanvas(view, cssW, cssH);
    }, [alignToExcalidraw, blitBakeToCanvas, getViewport, rebuildBake]);

    const syncCamera = useCallback(() => {
      if (drawingRef.current) return;
      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      const excalRect = alignToExcalidraw(canvas);
      const dpr = window.devicePixelRatio || 1;
      const cssW = excalRect?.width ?? viewport.width;
      const cssH = excalRect?.height ?? viewport.height;
      const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };
      const key = inkBakeKey(view, dpr, cssW, cssH, clipRef.current);

      if (!bakeRef.current || bakeKeyRef.current !== key) {
        canvas.style.transform = "";
        rebuildBake(view, dpr, cssW, cssH, key);
        blitBakeToCanvas(view, cssW, cssH);
        return;
      }

      const bakeView = bakeViewportRef.current;
      if (!bakeView) {
        canvas.style.transform = "";
        rebuildBake(view, dpr, cssW, cssH, key);
        blitBakeToCanvas(view, cssW, cssH);
        return;
      }

      const dx = (view.scrollX - bakeView.scrollX) * view.zoom;
      const dy = (view.scrollY - bakeView.scrollY) * view.zoom;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
        canvas.style.transform = "";
        return;
      }
      canvas.style.transform = `translate(${dx}px, ${dy}px)`;
    }, [alignToExcalidraw, blitBakeToCanvas, getViewport, rebuildBake]);

    /** Full rebuild: clear, blit bake, replay entire live op. Used on zoom/undo. */
    const repaint = useCallback(() => {
      const canvas = canvasRef.current;
      // Prefer the stroke-start frame while a gesture is open (or just set up).
      const frozen = strokeViewRef.current;
      const box = strokeBoxRef.current;
      const viewport = frozen ?? getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      canvas.style.transform = "";
      const excalRect = frozen && box ? box : alignToExcalidraw(canvas);
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
        // Whole device pixels, same as alignToExcalidraw — see the note there.
        canvas.style.width = `${pixelW / dpr}px`;
        canvas.style.height = `${pixelH / dpr}px`;
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
     * re-blitting the bake. Uses the stroke-start viewport so a camera jitter
     * cannot force a full rebuild mid-glyph.
     */
    const paintLiveIncremental = useCallback(() => {
      const canvas = canvasRef.current;
      const view = strokeViewRef.current;
      const box = strokeBoxRef.current;
      const live = liveRef.current;
      if (!canvas || !view || !box || !live || box.width < 1 || box.height < 1) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = box.width;
      const cssH = box.height;
      const key = inkBakeKey(view, dpr, cssW, cssH, clipRef.current);
      // Size/DPR change only — never scroll/zoom mid-stroke (those are frozen).
      if (
        !bakeRef.current ||
        bakeKeyRef.current !== key ||
        canvas.width !== Math.round(cssW * dpr) ||
        canvas.height !== Math.round(cssH * dpr)
      ) {
        // Still avoid a full clear if we can: ensureBake under the frozen view.
        ensureBake(view, dpr, cssW, cssH);
        if (
          !bakeRef.current ||
          canvas.width !== Math.round(cssW * dpr) ||
          canvas.height !== Math.round(cssH * dpr)
        ) {
          repaint();
          return;
        }
        // Blit bake then continue incremental from current fromIndex.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bakeRef.current, 0, 0);
        liveDrawnIndexRef.current = 0;
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
    }, [ensureBake, repaint]);

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
        isDrawing() {
          return drawingRef.current;
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
        syncCamera,
        commitCamera,
      }),
      [commitCamera, invalidateBake, onChange, repaint, syncCamera],
    );

    useEffect(() => {
      if (drawingRef.current) return;
      invalidateBake();
      repaint();
    }, [enabled, clip, invalidateBake, repaint]);

    useEffect(() => {
      if (!enabled) return;
      const onResize = () => {
        if (drawingRef.current) return;
        invalidateBake();
        repaint();
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [enabled, invalidateBake, repaint]);

    useEffect(() => {
      if (!enabled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const begin = (event: PointerEvent) => {
        if (!toolRef.current) return;
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
        // Freeze camera + CSS box for the whole stroke before the first paint.
        // Align once here — never again on move (DOM writes mid-glyph hitch).
        const excalRect = alignToExcalidraw(canvas);
        const cssW = excalRect?.width ?? viewport.width;
        const cssH = excalRect?.height ?? viewport.height;
        const strokeView: ViewportTransform = {
          ...viewport,
          width: cssW,
          height: cssH,
        };
        strokeViewRef.current = strokeView;
        strokeBoxRef.current = { width: cssW, height: cssH };

        const rect = canvas.getBoundingClientRect();
        const point = scenePointFromPointer(
          event.clientX,
          event.clientY,
          rect,
          strokeView,
          event.pressure,
          event.pointerType,
        );
        lastPointRef.current = point;
        smoothedPressureRef.current = hasStylusPressure(point.pressure) ? point.pressure : 0;
        inkMetrics.begin();
        const width = strokeWidthRef.current;
        const activeTool = toolRef.current;
        if (activeTool === "pen") {
          liveRef.current = {
            kind: "draw",
            color: inkColorRef.current,
            baseWidth: width,
            maxFullness: inkFullnessRef.current,
            pressureClip: pressureClipRef.current,
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
        // Full blit under the frozen view while drawingRef is still false so
        // scroll/resize guards do not skip this first paint.
        repaintRef.current();
        drawingRef.current = true;
      };

      const move = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        const strokeView = strokeViewRef.current;
        if (!strokeView) return;
        event.preventDefault();
        const live = liveRef.current;
        if (!live) return;
        const rect = canvas.getBoundingClientRect();

        /*
         * Every sample the browser buffered since the last frame, in order.
         *
         * A stylus reporting above display Hz gets one `pointermove` per frame
         * and the rest of its samples inside `getCoalescedEvents()`. Reading
         * only the move throws the others away, which is what turns a fast
         * curve into a chain of straight chords — and the faster you write, the
         * more of the stroke is chord. Consuming the batch costs one extra
         * `stampAlongSegment` per sample and still paints once per frame.
         */
        const coalesced = event.getCoalescedEvents?.();
        const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
        inkMetrics.move(batch.length);

        const width = strokeWidthRef.current;
        const pressureSensitive = live.kind === "draw" && live.pressureSensitive;
        const maxFullness = live.kind === "draw" ? live.maxFullness : 1;
        const pressureClip = live.kind === "draw" ? live.pressureClip : 1;
        for (const sample of batch) {
          const last = lastPointRef.current;
          if (!last) break;
          const point = scenePointFromPointer(
            sample.clientX,
            sample.clientY,
            rect,
            strokeView,
            sample.pressure,
            sample.pointerType,
          );
          if (pressureSensitive && hasStylusPressure(point.pressure)) {
            // Filter pressure, not position: smoothing the path would lag the
            // tip, but width has no business tracking sample noise.
            smoothedPressureRef.current = smoothPressure(
              smoothedPressureRef.current,
              point.pressure,
            );
            point.pressure = smoothedPressureRef.current;
          } else {
            point.pressure = NO_PRESSURE;
          }
          const step =
            live.kind === "erase"
              ? Math.max(live.radius * 0.45, 0.5)
              : (() => {
                  const style = inkStrokeStyle(
                    width,
                    maxFullness,
                    point.pressure,
                    pressureClip,
                    pressureSensitive,
                  );
                  return Math.max(
                    style.lineWidth *
                      (pressureSensitive && hasStylusPressure(point.pressure)
                        ? INK_STEP_FACTOR_PRESSURE
                        : INK_STEP_FACTOR),
                    0.5,
                  );
                })();
          const stamps = stampAlongSegment(last, point, step);
          live.points.push(...stamps);
          lastPointRef.current = point;
        }
        paintLiveIncrementalRef.current();
        inkMetrics.painted(event.timeStamp);
      };

      const end = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        strokeViewRef.current = null;
        strokeBoxRef.current = null;
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        commitLiveRef.current();
        inkMetrics.end();
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
      // Tool is read via toolRef — never rebind listeners when pen↔eraser flips.
      // Paint callbacks stay on refs so a Board re-render never drops capture.
    }, [alignToExcalidraw, enabled]);

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
