/**
 * Bitmap ink layer over Excalidraw — pen draws pixels; eraser clears them.
 *
 * Committed ink lives in a scene-space tile cache (see {@link InkTileCache}), so
 * a camera move is a handful of blits rather than a replay of the page. The
 * stroke under the pen is never tiled: it paints straight onto the overlay,
 * incrementally, so nothing stands between a pointer sample and a pixel.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import {
  applyInkOpFrom,
  eraserSceneRadius,
  hasStylusPressure,
  inkStrokeStyle,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  NO_PRESSURE,
  scenePointFromPointer,
  setInkSceneTransform,
  smoothPressure,
  stampAlongSegment,
  type InkOp,
  type SceneBounds,
  type ViewportTransform,
} from "./rasterInk";
import { InkTileCache, paintLiveOp } from "./inkTiles";
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
  /** Camera moved — reblit the visible tiles and rasterise what is exposed. */
  syncCamera(): void;
  /** End of a pan, flick or zoom. Same work; kept apart for the call sites. */
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
     * Mid-stroke scroll/zoom used to invalidate the bake and force a full
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

    /**
     * Committed ink, tiled per zoom level. Live ink never enters it — see
     * {@link paintLiveIncremental}.
     */
    const tilesRef = useRef<InkTileCache | null>(null);
    const ensureTiles = useCallback(() => {
      if (!tilesRef.current) {
        tilesRef.current = new InkTileCache({
          // A background pass finished squares the last frame could not afford;
          // put them on screen without waiting for the next camera event.
          onTilesReady: () => {
            if (drawingRef.current) return;
            repaintRef.current();
          },
        });
        tilesRef.current.setOps(opsRef.current);
      }
      return tilesRef.current;
    }, []);

    /** Match the backing store to the CSS box, on whole device pixels. */
    const sizeCanvas = useCallback(
      (canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number) => {
        const pixelW = Math.max(1, Math.round(cssW * dpr));
        const pixelH = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== pixelW || canvas.height !== pixelH) {
          canvas.width = pixelW;
          canvas.height = pixelH;
          // Whole device pixels, same as alignToExcalidraw — see the note there.
          canvas.style.width = `${pixelW / dpr}px`;
          canvas.style.height = `${pixelH / dpr}px`;
        }
        return { pixelW, pixelH };
      },
      [],
    );

    /**
     * Blit committed tiles for the current camera, then the live stroke on top.
     *
     * Cheap enough to call every pan and zoom frame: it is a handful of
     * `drawImage` calls plus whatever rasterising fits in one frame's budget.
     * Nothing here replays the page.
     */
    const paintFrame = useCallback(
      (viewport: ViewportTransform, cssW: number, cssH: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const { pixelW, pixelH } = sizeCanvas(canvas, cssW, cssH, dpr);
        const view: ViewportTransform = { ...viewport, width: cssW, height: cssH };

        const tiles = ensureTiles();
        tiles.setClip(clipRef.current);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pixelW, pixelH);
        tiles.draw(ctx, view, dpr);

        const live = liveRef.current;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (live) {
          paintLiveOp(ctx, live, view, dpr, clipRef.current);
          liveDrawnIndexRef.current =
            live.kind === "draw" ? Math.max(0, live.points.length - 1) : live.points.length;
        } else {
          liveDrawnIndexRef.current = 0;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
      [ensureTiles, sizeCanvas],
    );

    /** Full repaint of the overlay at the current (or frozen) camera. */
    const repaint = useCallback(() => {
      const canvas = canvasRef.current;
      // Prefer the stroke-start frame while a gesture is open (or just set up).
      const frozen = strokeViewRef.current;
      const box = strokeBoxRef.current;
      const viewport = frozen ?? getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      const excalRect = frozen && box ? box : alignToExcalidraw(canvas);
      paintFrame(viewport, excalRect?.width ?? viewport.width, excalRect?.height ?? viewport.height);
    }, [alignToExcalidraw, getViewport, paintFrame]);

    const repaintRef = useRef(repaint);
    repaintRef.current = repaint;

    /**
     * Camera moved. There is nothing cheaper to do than repaint now: tiles the
     * pan or zoom already covered are a blit, and the ones it exposed are
     * rasterised inside a frame budget rather than all at once.
     *
     * This replaced a CSS translate of a viewport-sized bake, which left the
     * newly exposed ground blank until the gesture ended and then replayed the
     * whole page in one blocking go.
     */
    const syncCamera = useCallback(() => {
      if (drawingRef.current) return;
      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      canvas.style.transform = "";
      const excalRect = alignToExcalidraw(canvas);
      paintFrame(viewport, excalRect?.width ?? viewport.width, excalRect?.height ?? viewport.height);
    }, [alignToExcalidraw, getViewport, paintFrame]);

    /** End of a pan or zoom. Same work — kept apart for the call sites. */
    const commitCamera = syncCamera;

    const invalidateTiles = useCallback(() => {
      ensureTiles().setOps(opsRef.current);
    }, [ensureTiles]);

    /**
     * Hot path: paint only new live segments without clearing or re-blitting.
     * Uses the stroke-start viewport so a camera jitter cannot force a full
     * repaint mid-glyph.
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
      // A resize mid-stroke resets the backing store and wipes what is drawn;
      // the only honest recovery is a full repaint under the frozen camera.
      if (
        canvas.width !== Math.round(box.width * dpr) ||
        canvas.height !== Math.round(box.height * dpr)
      ) {
        repaint();
        return;
      }

      const frame: ViewportTransform = { ...view, width: box.width, height: box.height };
      setInkSceneTransform(ctx, frame, dpr);
      const clipBox = clipRef.current;
      const from = liveDrawnIndexRef.current;
      const pixelScale = frame.zoom * dpr;
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
        liveDrawnIndexRef.current = applyInkOpFrom(ctx, live, from, pixelScale);
        ctx.restore();
      } else {
        liveDrawnIndexRef.current = applyInkOpFrom(ctx, live, from, pixelScale);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }, [repaint]);

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

      // Only the tiles the stroke landed on are dropped, so committing on a
      // full page costs the same as committing on an empty one.
      ensureTiles().appendOp(live);
      repaint();
      onChange?.();
    }, [ensureTiles, onChange, repaint]);

    const paintLiveIncrementalRef = useRef(paintLiveIncremental);
    paintLiveIncrementalRef.current = paintLiveIncremental;
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
          invalidateTiles();
          repaint();
          onChange?.();
        },
        undo() {
          if (undoRef.current.length === 0) return false;
          redoRef.current.push(cloneOps(opsRef.current));
          opsRef.current = undoRef.current.pop() ?? [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateTiles();
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
          invalidateTiles();
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
          invalidateTiles();
          repaint();
        },
        repaint,
        syncCamera,
        commitCamera,
      }),
      [commitCamera, invalidateTiles, onChange, repaint, syncCamera],
    );

    // The clip is compared inside the cache, which drops its tiles only when the
    // page actually changed — repainting on every render is just a blit.
    useEffect(() => {
      if (drawingRef.current) return;
      repaint();
    }, [enabled, clip, repaint]);

    useEffect(() => {
      if (!enabled) return;
      const onResize = () => {
        if (drawingRef.current) return;
        // Tiles live in scene space, so a window resize costs a repaint of the
        // overlay and nothing else — the cache survives intact.
        repaint();
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [enabled, repaint]);

    useEffect(() => () => tilesRef.current?.dispose(), []);

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
