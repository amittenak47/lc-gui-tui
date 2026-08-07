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
  inkLineWidth,
  inkSlowness,
  inkStrokeStyle,
  INK_SLOWNESS_NEUTRAL,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  NO_PRESSURE,
  scenePointFromPointer,
  setInkSceneTransform,
  smoothPressure,
  smoothSpeed,
  stampAlongSegment,
  type InkOp,
  type ScenePoint,
  type SceneBounds,
  type ViewportTransform,
} from "./rasterInk";
import { InkTileCache, paintLiveOp } from "./inkTiles";
import { panDelta, type PanCamera } from "./panOffset";
import {
  liveSmoothingTau,
  liveSmoothingWeight,
  smoothInkPoints,
  type InkSmoothingMode,
} from "./inkSmoothing";
import { DEBUG_INK, inkMetrics } from "./inkMetrics";

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
  /**
   * Ride the page on the compositor instead of reblitting for it.
   *
   * A reading gesture leaves Excalidraw's camera frozen and moves the markdown
   * slot by a transform; this is the same move for the ink, and it is what
   * keeps a coast off the raster path entirely. `null` puts the bitmap back on
   * its painted coordinates.
   *
   * Returns false when the translate cannot honestly stand in for a repaint —
   * the zoom changed, or the page has travelled past what one painted
   * screenful can cover — and the caller should rebase onto a real paint.
   */
  setPanOffset(live: PanCamera | null): boolean;
  /** End of a pan, flick or zoom. Same work; kept apart for the call sites. */
  commitCamera(): void;
  /**
   * A camera gesture opened or settled.
   *
   * Bracketing the gesture is what lets the frames inside it be cheap: the tile
   * level is pinned so a zoom cannot invalidate the screen mid-animation, and
   * the rasterising budget drops to a sliver. Unbracketed, every frame is
   * entitled to 5ms of tile building for a camera that has already moved on.
   */
  setCameraMoving(moving: boolean): void;
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
  /** Vector smoothing strength (0–1). 0 keeps the raw samples. */
  smoothing?: number;
  /** Whether {@link smoothing} is applied on the lift or under the nib. */
  smoothingMode?: InkSmoothingMode;
  /** Speed-ink strength (0–1): a slow nib lays down more than a fast one. */
  speedInk?: number;
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

/**
 * Remember *which* ops were on the page, not a copy of every point on it.
 *
 * A committed op is never written to again — only `liveRef` is pushed to, and
 * the lift hands its array straight over — so an undo step only has to hold the
 * list. Deep-cloning it meant every pen lift copied every stamp on the board,
 * which is a cost that grows with the page: the fortieth letter cloned
 * thirty-nine strokes' worth of points, and up to forty of those snapshots were
 * kept alive at once. That is the pause after the pen comes up, and the reason
 * it got worse the longer you wrote.
 */
function snapshotOps(ops: readonly InkOp[]): InkOp[] {
  return [...ops];
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
      smoothing = 0,
      smoothingMode = "lift",
      speedInk = 0,
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
    /**
     * The one pointer the open stroke belongs to.
     *
     * Everything on the layer used to answer to any pointer id at all, which is
     * what a resting palm or a second finger turns into with palm reject off: a
     * `pointerdown` that ended the letter under the pen, `pointermove`s that
     * dragged the live stroke off to wherever the hand was, and a `pointerup`
     * that committed the whole mess. One writer at a time — a stroke is owned by
     * the pointer that started it until that pointer lifts.
     */
    const activePointerRef = useRef<number | null>(null);
    /**
     * Close an open stroke without committing it. Filled in by the pointer
     * effect, which owns the capture and the window fallback.
     */
    const abandonStrokeRef = useRef<() => void>(() => {});
    const lastPointRef = useRef<ScenePoint | null>(null);
    /**
     * Where the pen actually was, before live smoothing pulled the nib off it.
     * Speed is measured against this, and the lift settles onto it.
     */
    const rawPointRef = useRef<ScenePoint | null>(null);
    /** Running EMA of raw stylus pressure for the live stroke — see smoothPressure. */
    const smoothedPressureRef = useRef(0);
    /** Running EMA of hand speed in CSS px/ms — see smoothSpeed. */
    const smoothedSpeedRef = useRef(0);
    /** `event.timeStamp` of the last sample consumed, for speed and live smoothing. */
    const lastSampleTimeRef = useRef(0);
    /**
     * Viewport + CSS box frozen at pointerdown for the whole stroke.
     *
     * Mid-stroke scroll/zoom used to invalidate the bake and force a full
     * `repaint()` on every move — that hitch is what cuts a letter like "g"
     * short. Keep mapping and incremental paint on the stroke-start frame.
     */
    const strokeViewRef = useRef<ViewportTransform | null>(null);
    const strokeBoxRef = useRef<{ width: number; height: number } | null>(null);
    /**
     * The canvas rect, read once at pointerdown and reused for every sample.
     *
     * `getBoundingClientRect()` flushes style and layout, and this used to run
     * inside `pointermove` — a forced synchronous layout of the whole board,
     * Excalidraw and toolbars included, on every single input event. The box is
     * frozen for the stroke anyway (see `strokeBoxRef`), so there was never
     * anything to learn from asking again.
     */
    const strokeRectRef = useRef<DOMRect | null>(null);
    /**
     * The overlay's CSS box, as last measured against the Excalidraw canvas.
     *
     * `alignToExcalidraw` reads two `getBoundingClientRect()`s, which is a
     * forced synchronous layout of the whole board. That ran on every camera
     * frame — a pan at 90Hz laid out the board, Excalidraw and toolbars ninety
     * times a second to re-learn a number that only a resize can change. Cached
     * here and dropped by the resize observer below.
     */
    const alignedBoxRef = useRef<{ width: number; height: number } | null>(null);
    /**
     * A background tile pass finished while the pen was down, so the overlay is
     * a frame behind the cache. Repaint once the stroke is off the paper.
     */
    const tilesDirtyRef = useRef(false);
    /** A pan / zoom gesture is open — see {@link RasterInkHandle.setCameraMoving}. */
    const cameraMovingRef = useRef(false);
    /**
     * What `paintFrame` last put on the overlay, so a pointerdown that changes
     * nothing can skip the blit instead of paying for it at the worst moment.
     */
    const paintedViewRef = useRef<{
      zoom: number;
      scrollX: number;
      scrollY: number;
      width: number;
      height: number;
      ops: number;
      clip: SceneBounds | null;
      live: boolean;
      settled: boolean;
    } | null>(null);
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
    const smoothingRef = useRef(smoothing);
    smoothingRef.current = smoothing;
    const smoothingModeRef = useRef(smoothingMode);
    smoothingModeRef.current = smoothingMode;
    const speedInkRef = useRef(speedInk);
    speedInkRef.current = speedInk;
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
      /*
       * Measure where the Excalidraw canvas *lives*, not where a pan is holding
       * it. Excalidraw's canvases ride the same live-pan translate this layer
       * does (see `setPanOffset`), so a re-measure mid-gesture — a rotation, the
       * keyboard opening — would bake the gesture's offset into the overlay's
       * own left/top and leave it there for good.
       */
      const boardStyle = board instanceof HTMLElement ? getComputedStyle(board) : null;
      const panX = Number.parseFloat(boardStyle?.getPropertyValue("--lc-pan-x") ?? "") || 0;
      const panY = Number.parseFloat(boardStyle?.getPropertyValue("--lc-pan-y") ?? "") || 0;
      const width = snap(excalRect.width);
      const height = snap(excalRect.height);
      canvas.style.left = `${snap(excalRect.left - boardRect.left - panX)}px`;
      canvas.style.top = `${snap(excalRect.top - boardRect.top - panY)}px`;
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
            // Mid-stroke this used to be dropped on the floor, and with it the
            // only chance those squares had to reach the screen: the live path
            // paints the new tail and nothing else, so ink that was ready but
            // unblitted stayed invisible for as long as the pen kept writing.
            // Owe the repaint instead of skipping it — the lift is a moment
            // later and costs nothing, where a blit mid-glyph would hitch.
            // Same during a camera gesture, and for the same reason the pan is
            // a translate at all: a full clear-and-blit is the one thing a
            // coast cannot afford. The settle repaints unconditionally.
            if (drawingRef.current || cameraMovingRef.current) {
              tilesDirtyRef.current = true;
              return;
            }
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
        // A paint is the thing a pan offset was standing in for. Whatever the
        // gesture had slid the bitmap to, these pixels are the honest answer at
        // `viewport`, and they belong at the layer's own coordinates.
        if (canvas.style.transform) canvas.style.transform = "";

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

        tilesDirtyRef.current = false;
        paintedViewRef.current = {
          zoom: viewport.zoom,
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
          width: cssW,
          height: cssH,
          ops: opsRef.current.length,
          clip: clipRef.current,
          live: live !== null,
          settled: tiles.settled,
        };
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
      let excalRect = frozen && box ? box : alignedBoxRef.current;
      if (!excalRect) {
        excalRect = alignToExcalidraw(canvas);
        if (!frozen) alignedBoxRef.current = excalRect;
      }
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
    const paintCamera = useCallback(() => {
      if (drawingRef.current) return;
      const canvas = canvasRef.current;
      const viewport = getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      const excalRect = alignedBoxRef.current ?? alignToExcalidraw(canvas);
      alignedBoxRef.current = excalRect;
      paintFrame(viewport, excalRect?.width ?? viewport.width, excalRect?.height ?? viewport.height);
    }, [alignToExcalidraw, getViewport, paintFrame]);

    /** A camera repaint owed to the next frame, if one is already booked. */
    const cameraFrameRef = useRef(0);

    /**
     * Camera moved — repaint, but no more than once a frame.
     *
     * The screen cannot show two cameras in one frame, so painting twice for
     * one is a whole wasted clear-and-blit. It happened routinely: the bounds
     * clamp answers a scroll event with `updateScene`, which raises another
     * scroll event, and both used to repaint. Coalescing also means the paint
     * lands inside the frame's own rAF, after the scroll handlers are done,
     * rather than in the middle of one.
     */
    const syncCamera = useCallback(() => {
      if (drawingRef.current || cameraFrameRef.current) return;
      cameraFrameRef.current = requestAnimationFrame(() => {
        cameraFrameRef.current = 0;
        paintCamera();
      });
    }, [paintCamera]);

    /**
     * End of a pan or zoom: unpin the tile level, then paint one honest frame.
     *
     * The order matters. Releasing first is what makes this the frame that
     * re-levels and starts rasterising at full budget, so the softness a
     * pinned gesture traded for smoothness is paid back the moment it ends.
     */
    const commitCamera = useCallback(() => {
      tilesRef.current?.setMoving(false);
      // The settle paints now rather than next frame: a coalesced repaint would
      // still be carrying the pinned level's softness for one more frame, and
      // this is the frame the writer is looking at when they let go.
      if (cameraFrameRef.current) {
        cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = 0;
      }
      paintCamera();
    }, [paintCamera]);

    const setCameraMoving = useCallback(
      (moving: boolean) => {
        cameraMovingRef.current = moving;
        if (moving) {
          // Re-measuring is a forced layout, and a gesture is the worst moment
          // for one. The box cannot change mid-pan anyway — only a resize moves
          // it, and that invalidates this itself.
          const canvas = canvasRef.current;
          if (canvas && !alignedBoxRef.current) {
            alignedBoxRef.current = alignToExcalidraw(canvas);
          }
          ensureTiles().setMoving(true);
          return;
        }
        commitCamera();
      },
      [alignToExcalidraw, commitCamera, ensureTiles],
    );

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
      undoRef.current.push(snapshotOps(opsRef.current));
      // Cap undo depth — each snapshot clones every point, and erase stamps are dense.
      if (undoRef.current.length > 40) {
        undoRef.current.splice(0, undoRef.current.length - 40);
      }
      redoRef.current = [];

      /*
       * Smooth the pen stroke now that it is finished.
       *
       * On commit rather than per sample: smoothing a live stroke means lagging
       * the tip behind the nib, and ink that trails the pen is worse than ink
       * that wobbles. Waiting for the lift buys a symmetric filter with no
       * latency at all, at the cost of a settle nobody notices at the default
       * strength. The eraser is left alone — its stamps are a coverage mask,
       * not a line, and rounding them would leave crumbs behind.
       */
      // In live mode the filter already ran under the nib; running it again on
      // the lift would move ink the writer has already watched settle.
      const smoothing = smoothingModeRef.current === "live" ? 0 : smoothingRef.current;
      // Unconditional for a pen stroke, even at zero smoothing: below the
      // requested tolerance sits a storage floor that thins the stamp chain
      // without moving the line — see SIMPLIFY_STORAGE_FRACTION. The eraser is
      // left alone, its stamps being a coverage mask rather than a path.
      const committed =
        live.kind === "draw"
          ? {
              ...live,
              points: smoothInkPoints(
                live.points,
                smoothing,
                inkLineWidth(live.baseWidth, 0, false),
              ),
            }
          : live;

      opsRef.current = [...opsRef.current, committed];
      liveRef.current = null;
      liveDrawnIndexRef.current = 0;
      lastPointRef.current = null;
      rawPointRef.current = null;

      // Only the tiles the stroke landed on are dropped, so committing on a
      // full page costs the same as committing on an empty one.
      ensureTiles().appendOp(committed);
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
          abandonStrokeRef.current();
          if (opsRef.current.length === 0) return;
          undoRef.current.push(snapshotOps(opsRef.current));
          redoRef.current = [];
          opsRef.current = [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateTiles();
          repaint();
          onChange?.();
        },
        undo() {
          abandonStrokeRef.current();
          if (undoRef.current.length === 0) return false;
          redoRef.current.push(snapshotOps(opsRef.current));
          opsRef.current = undoRef.current.pop() ?? [];
          liveRef.current = null;
          liveDrawnIndexRef.current = 0;
          invalidateTiles();
          repaint();
          onChange?.();
          return true;
        },
        redo() {
          abandonStrokeRef.current();
          if (redoRef.current.length === 0) return false;
          undoRef.current.push(snapshotOps(opsRef.current));
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
          abandonStrokeRef.current();
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
        setPanOffset(live) {
          const canvas = canvasRef.current;
          if (!canvas) return true;
          if (!live) {
            if (canvas.style.transform) canvas.style.transform = "";
            return true;
          }
          // The pen owns the bitmap while it is down — the stroke is painted
          // against a frozen camera, and sliding it would take the wet ink with
          // it. Report success: there is nothing for the caller to rebase onto.
          if (drawingRef.current) return true;
          const painted = paintedViewRef.current;
          if (!painted) return false;
          const delta = panDelta(live, painted, painted);
          if (delta.rebase) return false;
          const next =
            delta.dx === 0 && delta.dy === 0
              ? ""
              : `translate3d(${delta.dx}px, ${delta.dy}px, 0)`;
          if (canvas.style.transform !== next) canvas.style.transform = next;
          return true;
        },
        commitCamera,
        setCameraMoving,
      }),
      [commitCamera, invalidateTiles, onChange, repaint, setCameraMoving, syncCamera],
    );

    /**
     * Drop the cached box when the board actually resizes.
     *
     * Rotation, the keyboard opening, a dock appearing — all of them move the
     * Excalidraw canvas, and none of them go through a camera event. Watching
     * for it is what makes it safe never to re-measure on a pan.
     */
    useEffect(() => {
      const canvas = canvasRef.current;
      const board = canvas?.parentElement;
      if (!board || typeof ResizeObserver !== "function") return;
      const observer = new ResizeObserver(() => {
        alignedBoxRef.current = null;
        if (drawingRef.current) return;
        repaintRef.current();
      });
      observer.observe(board);
      return () => observer.disconnect();
    }, []);

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

      /** Window listeners are up because `setPointerCapture` was refused. */
      let windowFallback = false;
      /** Last move consumed, so the fallback and the canvas cannot double-stamp. */
      let lastHandledMove: PointerEvent | null = null;

      /**
       * Land the nib where the pen actually lifted.
       *
       * Live smoothing leaves the ink a fraction of a time constant behind the
       * hand, so without this every stroke stops just short of where it was
       * drawn — a descender that never reaches the line, a cross that misses
       * its stem. The tail is at most a couple of frames of travel.
       */
      const settleLiveTip = () => {
        const live = liveRef.current;
        const last = lastPointRef.current;
        const raw = rawPointRef.current;
        if (!live || live.kind !== "draw" || !last || !raw) return;
        if (Math.hypot(raw.x - last.x, raw.y - last.y) < 1e-3) return;
        const style = inkStrokeStyle(
          live.baseWidth,
          live.maxFullness,
          raw.pressure,
          live.pressureClip,
          live.pressureSensitive,
          0,
          raw.slowness ?? INK_SLOWNESS_NEUTRAL,
          live.speedInk ?? 0,
        );
        const step = Math.max(style.lineWidth * INK_STEP_FACTOR_PRESSURE, 0.5);
        live.points.push(...stampAlongSegment(last, raw, step));
        lastPointRef.current = raw;
      };

      const begin = (event: PointerEvent) => {
        if (!toolRef.current) {
          if (DEBUG_INK) inkMetrics.note("no-tool");
          return;
        }
        if (onStylusAccessoryRef.current?.(event)) {
          if (DEBUG_INK) inkMetrics.note("accessory");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // Primary tip only for drawing. Barrel / eraser tip are accessory.
        if (event.button !== 0) {
          if (DEBUG_INK) inkMetrics.note("not-primary");
          return;
        }
        const viewport = getViewportRef.current();
        if (!viewport) {
          if (DEBUG_INK) inkMetrics.note("no-viewport");
          return;
        }
        if (!isCanvasTarget(event.target, canvas)) {
          if (DEBUG_INK) inkMetrics.note("off-canvas");
          return;
        }
        event.preventDefault();
        event.stopPropagation();

        if (drawingRef.current) {
          /*
           * A second pointer while the pen is still down.
           *
           * With palm reject off this is a resting hand, not a new stroke. The
           * pointer that owns the stroke is the one holding capture, so ask:
           * if it still has it, the nib is still on the paper and this touch
           * has no business ending the letter under it.
           */
          const active = activePointerRef.current;
          if (
            active !== null &&
            active !== event.pointerId &&
            canvas.hasPointerCapture(active)
          ) {
            if (DEBUG_INK) inkMetrics.note("second-pointer");
            return;
          }
          /*
           * A stroke that never got its pointerup.
           *
           * It happens: a stylus that leaves proximity mid-flick, a capture the
           * compositor takes away, an app switch. The old code walked straight
           * past it and overwrote `liveRef`, which threw the stroke away —
           * painted on the overlay, in no op, gone at the next repaint. That is
           * the letter that "randomly" fails to appear. Close it out first; a
           * stroke the writer finished belongs on the page either way.
           */
          if (DEBUG_INK) inkMetrics.note("orphan-commit");
          drawingRef.current = false;
          activePointerRef.current = null;
          settleLiveTip();
          strokeViewRef.current = null;
          strokeBoxRef.current = null;
          strokeRectRef.current = null;
          detachWindowFallback();
          commitLiveRef.current();
        }
        try {
          canvas.setPointerCapture(event.pointerId);
          detachWindowFallback();
        } catch {
          /*
           * Capture refused. Without it the moves stop arriving the moment the
           * nib crosses the edge of the overlay, and the stroke strands
           * half-drawn — the swallowed failure was invisible from the outside.
           * Follow the pointer on the window for the length of this stroke
           * instead of quietly writing off everything past the edge.
           */
          if (DEBUG_INK) inkMetrics.note("no-capture");
          attachWindowFallback();
        }
        // Freeze camera + CSS box for the whole stroke before the first paint.
        // Align once here — never again on move (DOM writes mid-glyph hitch).
        const excalRect = alignToExcalidraw(canvas);
        alignedBoxRef.current = excalRect;
        /*
         * The pen lands on paper, not on a translate.
         *
         * A live pan slides this bitmap rather than repainting it (see
         * `setPanOffset`), which leaves the committed ink drawn for one camera
         * and the canvas standing at another. Everything below maps the stroke
         * through the canvas's own box, so opening one on top of that offset
         * would lay it down displaced by the length of the gesture. Repaint for
         * the camera the writer is looking at — a nib touching down is a frame
         * we can afford, and a stroke in the wrong place is not.
         */
        if (canvas.style.transform) repaintRef.current();
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
        strokeRectRef.current = rect;
        const point = scenePointFromPointer(
          event.clientX,
          event.clientY,
          rect,
          strokeView,
          event.pressure,
          event.pointerType,
        );
        const speed = speedInkRef.current;
        // Start at the neutral pace rather than at rest: the nib has no history
        // yet, and seeding it "stopped" would open every stroke with a blob.
        if (speed > 0) point.slowness = INK_SLOWNESS_NEUTRAL;
        lastPointRef.current = point;
        rawPointRef.current = point;
        smoothedPressureRef.current = hasStylusPressure(point.pressure) ? point.pressure : 0;
        smoothedSpeedRef.current = 0;
        lastSampleTimeRef.current = event.timeStamp;
        if (DEBUG_INK) inkMetrics.begin();
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
            speedInk: speed,
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
        /*
         * Blit the committed page under the frozen view, unless the last frame
         * already is that.
         *
         * The repaint is here so the overlay is known-good before the first
         * sample lands — but between two letters nothing has moved, and the
         * pixels on screen are already the answer. Redoing the blit anyway put
         * a full tile pass at the one instant the hand is most sensitive to it:
         * the moment the nib touches down. `drawingRef` is still false so the
         * scroll/resize guards cannot skip this when it *is* needed.
         */
        const painted = paintedViewRef.current;
        const reusable =
          painted !== null &&
          !tilesDirtyRef.current &&
          painted.settled &&
          !painted.live &&
          painted.ops === opsRef.current.length &&
          painted.clip === clipRef.current &&
          painted.zoom === strokeView.zoom &&
          painted.scrollX === strokeView.scrollX &&
          painted.scrollY === strokeView.scrollY &&
          painted.width === cssW &&
          painted.height === cssH;
        if (!reusable) repaintRef.current();
        drawingRef.current = true;
        activePointerRef.current = event.pointerId;
      };

      const move = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        // A palm dragging across the layer is not this stroke.
        if (event.pointerId !== activePointerRef.current) return;
        // With the window fallback up, a move over the overlay reaches both
        // listeners; the first one to see it owns it.
        if (event === lastHandledMove) return;
        lastHandledMove = event;
        const strokeView = strokeViewRef.current;
        const rect = strokeRectRef.current;
        if (!strokeView || !rect) return;
        event.preventDefault();
        const live = liveRef.current;
        if (!live) return;

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
        // The batch is in report order, so its first entry is the oldest ink in
        // hand — and the only sample here whose age reflects a stall, since the
        // dispatched event carries the newest one.
        if (DEBUG_INK) inkMetrics.move(batch.length, batch[0]?.timeStamp);

        const width = strokeWidthRef.current;
        const pressureSensitive = live.kind === "draw" && live.pressureSensitive;
        const maxFullness = live.kind === "draw" ? live.maxFullness : 1;
        const pressureClip = live.kind === "draw" ? live.pressureClip : 1;
        const speedInk = live.kind === "draw" ? (live.speedInk ?? 0) : 0;
        // Live smoothing is a pen thing. The eraser's stamps are a coverage
        // mask, and lagging them behind the hand only leaves crumbs.
        const tau =
          live.kind === "draw" && smoothingModeRef.current === "live"
            ? liveSmoothingTau(smoothingRef.current)
            : 0;
        const zoom = strokeView.zoom || 1;

        for (const sample of batch) {
          const last = lastPointRef.current;
          const rawLast = rawPointRef.current;
          if (!last || !rawLast) break;
          const raw = scenePointFromPointer(
            sample.clientX,
            sample.clientY,
            rect,
            strokeView,
            sample.pressure,
            sample.pointerType,
          );
          const dt = sample.timeStamp - lastSampleTimeRef.current;
          lastSampleTimeRef.current = sample.timeStamp;

          if (pressureSensitive && hasStylusPressure(raw.pressure)) {
            // Filter pressure, not position: smoothing the path would lag the
            // tip, but width has no business tracking sample noise.
            smoothedPressureRef.current = smoothPressure(
              smoothedPressureRef.current,
              raw.pressure,
            );
            raw.pressure = smoothedPressureRef.current;
          } else {
            raw.pressure = NO_PRESSURE;
          }

          if (speedInk > 0) {
            // Screen distance over wall time. Scene units would make the same
            // hand read as "slow" simply because the board is zoomed in.
            const travelled =
              Math.hypot(raw.x - rawLast.x, raw.y - rawLast.y) * zoom;
            if (dt > 0) {
              smoothedSpeedRef.current = smoothSpeed(
                smoothedSpeedRef.current,
                travelled / dt,
              );
            }
            raw.slowness = inkSlowness(smoothedSpeedRef.current);
          }
          rawPointRef.current = raw;

          // Under live smoothing the nib chases the pen rather than tracing it.
          // Pressure and slowness are the hand's, and ride along unfiltered —
          // only the path lags.
          let point = raw;
          if (tau > 0) {
            const weight = liveSmoothingWeight(dt, tau);
            point = {
              ...raw,
              x: last.x + (raw.x - last.x) * weight,
              y: last.y + (raw.y - last.y) * weight,
            };
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
                    0,
                    point.slowness ?? INK_SLOWNESS_NEUTRAL,
                    speedInk,
                  );
                  // Speed ink moves the width too, so it stamps as finely as a
                  // pressure stroke does — the taper is the whole point.
                  const dense =
                    speedInk > 0 ||
                    (pressureSensitive && hasStylusPressure(point.pressure));
                  return Math.max(
                    style.lineWidth * (dense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
                    0.5,
                  );
                })();
          const stamps = stampAlongSegment(last, point, step);
          live.points.push(...stamps);
          lastPointRef.current = point;
        }
        paintLiveIncrementalRef.current();
        if (DEBUG_INK) inkMetrics.painted(event.timeStamp);
      };

      const end = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        // A palm lifting off is not the pen lifting off.
        if (event.pointerId !== activePointerRef.current) return;
        drawingRef.current = false;
        activePointerRef.current = null;
        settleLiveTip();
        strokeViewRef.current = null;
        strokeBoxRef.current = null;
        strokeRectRef.current = null;
        detachWindowFallback();
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        commitLiveRef.current();
        if (DEBUG_INK) inkMetrics.end();
      };

      /*
       * Stand-in for pointer capture when the platform would not give it.
       *
       * Only up while a stroke is open, and gated on the owning pointer id like
       * everything else, so it cannot pick up a stray gesture elsewhere on the
       * page.
       */
      function attachWindowFallback(): void {
        if (windowFallback) return;
        windowFallback = true;
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", end, true);
        window.addEventListener("pointercancel", end, true);
      }

      function detachWindowFallback(): void {
        if (!windowFallback) return;
        windowFallback = false;
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      }

      /*
       * Throw away whatever the pen is in the middle of, and leave the layer in
       * a state where the next sample means something.
       *
       * `clear`, `undo`, `redo` and a notebook restore all null `liveRef` out
       * from under an open stroke. That is not "no stroke in progress" — it is
       * a stroke whose op has gone while `drawingRef` still says the nib is
       * down, and the difference is a whole letter: every `pointermove` after
       * it falls out at `if (!live) return`, so the rest of the stroke is
       * painted nowhere and recorded nowhere, and the lift commits nothing at
       * all. Nothing tells the writer; the letter is simply not there. Ending
       * the stroke properly costs the part already drawn — which is what those
       * four were asking for anyway — and keeps the next one honest.
       */
      abandonStrokeRef.current = () => {
        if (!drawingRef.current) return;
        if (DEBUG_INK) inkMetrics.note("stroke-abandoned");
        drawingRef.current = false;
        activePointerRef.current = null;
        strokeViewRef.current = null;
        strokeBoxRef.current = null;
        strokeRectRef.current = null;
        lastPointRef.current = null;
        rawPointRef.current = null;
        detachWindowFallback();
      };

      canvas.addEventListener("pointerdown", begin, true);
      canvas.addEventListener("pointermove", move, true);
      canvas.addEventListener("pointerup", end, true);
      canvas.addEventListener("pointercancel", end, true);
      // Capture taken away mid-stroke — an app switch, a system gesture. Without
      // this the moves stop arriving and the stroke is stranded, unpainted and
      // uncommitted, until the next pointerdown notices. `end` is a no-op on the
      // release we do ourselves, since it clears `drawingRef` first.
      canvas.addEventListener("lostpointercapture", end, true);
      return () => {
        canvas.removeEventListener("pointerdown", begin, true);
        canvas.removeEventListener("pointermove", move, true);
        canvas.removeEventListener("pointerup", end, true);
        canvas.removeEventListener("pointercancel", end, true);
        canvas.removeEventListener("lostpointercapture", end, true);
        detachWindowFallback();
        abandonStrokeRef.current = () => {};
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
