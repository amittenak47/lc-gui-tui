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
  eraserSceneRadius,
  hasStylusPressure,
  inkBaseWidthForZoom,
  inkLineWidth,
  inkSlowness,
  inkStrokeStyle,
  INK_ATTACK_MS,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_STEP_FACTOR,
  INK_STEP_FACTOR_PRESSURE,
  isHostBoundOp,
  NO_PRESSURE,
  scenePointFromPointer,
  smoothPressure,
  smoothSpeed,
  stampAlongSegment,
  type InkOp,
  type ScenePoint,
  type SceneBounds,
  type ScrollHostLookup,
  type ViewportTransform,
} from "./rasterInk";
import type { ScrollHostPaintState } from "./scrollHost";
import {
  DOC_PAGE_SELECTOR,
  docForScrollHost,
  horizontalScrollHostsIn,
  hostKeyInDoc,
  hostSceneBounds,
  scrollHostAtPoint,
  strokeBoundsInHost,
} from "./scrollHost";
import { InkTileCache, inkOpBounds, paintHostBoundPass, paintLiveOp } from "./inkTiles";
import { opsAfterStrokeErase } from "./strokeEraser";
import {
  OVERDRAW_REBASE_HEADROOM,
  overdrawMarginPx,
  overdrawnViewport,
  panDelta,
  PAN_REBASE_FRACTION,
  type PanCamera,
} from "./panOffset";
import {
  simplifyModulatedInkPoints,
  SIMPLIFY_MODULATED_FRACTION,
  smoothInkPoints,
  type InkSmoothingMode,
} from "./inkSmoothing";
import { DEBUG_INK, inkMetrics } from "./inkMetrics";
import { INK_SPEED_BLOT_BLEND_DEFAULT } from "../util/inkSpeedPref";
import { INK_BOLDNESS_DEFAULT } from "../util/inkBoldnessPref";

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
  tool: "pen" | "eraser" | "highlighter" | null;
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
  /** Soften speed-ink join/dwell discs (0–1). Stamped onto new pen strokes. */
  speedBlotBlend?: number;
  /** Opacity boost (0–3). Stamped onto new pen strokes. */
  inkBoldness?: number;
  /**
   * Eraser rubs pixels out (true) or takes whole strokes (false).
   *
   * See `util/eraserPartialPref` for which is the default and why.
   */
  partialErase?: boolean;
  getViewport: () => ViewportTransform | null;
  /**
   * Scene box the ink is allowed to show inside — the open page on a tablet,
   * `null` on the desktop's single stacked canvas.
   */
  clip?: SceneBounds | null;
  /** Live nested scroll hosts for host-bound ink paint and stroke capture. */
  getScrollHosts?: () => readonly ScrollHostPaintState[];
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
      speedBlotBlend = INK_SPEED_BLOT_BLEND_DEFAULT,
      inkBoldness = INK_BOLDNESS_DEFAULT,
      partialErase = true,
      getViewport,
      clip = null,
      getScrollHosts,
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
    /** Last live point count painted — bookkeeping for callers, not a paint-from index. */
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
    /**
     * Raw stamps for the open pen stroke when **While you write** is on.
     *
     * Display points are a reshape of this buffer (`smoothInkPoints`) every
     * paint, so earlier bends can tidy while the tip still tracks the pen.
     * Lift mode leaves this null and stamps straight into `live.points`.
     */
    const liveRawPointsRef = useRef<ScenePoint[] | null>(null);
    /** Running EMA of raw stylus pressure for the live stroke — see smoothPressure. */
    const smoothedPressureRef = useRef(0);
    /** Running EMA of hand speed in CSS px/ms — see smoothSpeed. */
    const smoothedSpeedRef = useRef(0);
    /** `event.timeStamp` of the last sample consumed, for speed and live smoothing. */
    const lastSampleTimeRef = useRef(0);
    /** Wall-clock time of the last real move/begin — dwell gate uses this, not DOMHighRes. */
    const lastMoveWallRef = useRef(0);
    /** Consecutive dwell samples since the last real move — caps runaway blobs. */
    const dwellCountRef = useRef(0);
    const dwellTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    /** Attack-window samples held before the first stamp (pressure-sensitive pen). */
    const attackBufferRef = useRef<ScenePoint[] | null>(null);
    const attackPeakRef = useRef(0);
    const attackStartRef = useRef(0);
    const attackCountRef = useRef(0);
    /**
     * Viewport + CSS box frozen at pointerdown for the whole stroke.
     *
     * Mid-stroke scroll/zoom used to invalidate the bake and force a full
     * `repaint()` on every move — that hitch is what cuts a letter like "g"
     * short. Keep mapping and incremental paint on the stroke-start frame.
     */
    const strokeViewRef = useRef<ViewportTransform | null>(null);
    const strokeBoxRef = useRef<{ width: number; height: number; marginY: number } | null>(null);
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
    /** Scroll host under the nib at pointerdown, if any. */
    const strokeHostRef = useRef<ScrollHostPaintState | null>(null);
    /**
     * The overlay's CSS box, as last measured against the Excalidraw canvas.
     *
     * `alignToExcalidraw` reads two `getBoundingClientRect()`s, which is a
     * forced synchronous layout of the whole board. That ran on every camera
     * frame — a pan at 90Hz laid out the board, Excalidraw and toolbars ninety
     * times a second to re-learn a number that only a resize can change. Cached
     * here and dropped by the resize observer below.
     */
    const alignedBoxRef = useRef<{ width: number; height: number; marginY: number } | null>(null);
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
      marginY: number;
      ops: number;
      clip: SceneBounds | null;
      live: boolean;
      settled: boolean;
    } | null>(null);
    // Read through a ref so a page turn doesn't rebuild `repaint` and with it
    // every pointer listener on the layer.
    const clipRef = useRef<SceneBounds | null>(clip);
    const usable =
      clip &&
      clip.maxX - clip.minX > 0 &&
      clip.maxY - clip.minY > 0
        ? clip
        : null;
    clipRef.current = usable;

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
    const speedBlotBlendRef = useRef(speedBlotBlend);
    speedBlotBlendRef.current = speedBlotBlend;
    const inkBoldnessRef = useRef(inkBoldness);
    inkBoldnessRef.current = inkBoldness;
    const partialEraseRef = useRef(partialErase);
    partialEraseRef.current = partialErase;
    const getScrollHostsRef = useRef(getScrollHosts);
    getScrollHostsRef.current = getScrollHosts;
    const toolRef = useRef(tool);
    toolRef.current = tool;

    function scrollHostLookup(): ScrollHostLookup {
      const map = new Map<number, { bounds: SceneBounds; scrollLeft: number }>();
      for (const host of collectScrollHosts()) {
        map.set(host.key, { bounds: host.bounds, scrollLeft: host.scrollLeft });
      }
      return map;
    }

    /** Live host list — prefer Board's callback, else walk the document slot. */
    function collectScrollHosts(): readonly ScrollHostPaintState[] {
      const provided = getScrollHostsRef.current?.();
      if (provided) return provided;
      const canvas = canvasRef.current;
      const view = strokeViewRef.current ?? getViewportRef.current();
      if (!canvas || !view) return [];
      const board = canvas.closest(".lc-board");
      if (!board) return [];
      const rect = canvas.getBoundingClientRect();
      const out: ScrollHostPaintState[] = [];
      for (const doc of board.querySelectorAll(DOC_PAGE_SELECTOR)) {
        for (const [key, el] of horizontalScrollHostsIn(doc).entries()) {
          out.push({
            key,
            scrollLeft: el.scrollLeft,
            bounds: hostSceneBounds(el, rect, view),
          });
        }
      }
      return out;
    }

    /** Attach host binding when the stroke's bounds land inside a scroll host. */
    function bindStrokeHost<T extends InkOp>(op: T): T {
      const host = strokeHostRef.current;
      if (!host) return op;
      const bounds = inkOpBounds(op);
      if (!strokeBoundsInHost(bounds, host.bounds)) return op;
      return { ...op, hostKey: host.key, scrollLeftAtDraw: host.scrollLeft };
    }

    /** Keep live ink aligned with a host the nib is inside. */
    function syncLiveHostBinding(live: InkOp): void {
      const host = strokeHostRef.current;
      if (!host) {
        if (live.hostKey !== undefined) {
          delete live.hostKey;
          delete live.scrollLeftAtDraw;
        }
        return;
      }
      const bounds = inkOpBounds(live);
      if (!strokeBoundsInHost(bounds, host.bounds)) {
        delete live.hostKey;
        delete live.scrollLeftAtDraw;
        return;
      }
      live.hostKey = host.key;
      live.scrollLeftAtDraw = host.scrollLeft;
    }

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
      const board = canvas.closest(".lc-board");
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
       * own left/top and leave it there for good. Inline `translate3d` is the
       * source of truth (Board no longer publishes `--lc-pan-*`).
       */
      const panMatch = /translate3d\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px/.exec(
        excal.style.transform || "",
      );
      const panX = panMatch ? Number(panMatch[1]) : 0;
      const panY = panMatch ? Number(panMatch[2]) : 0;
      const width = snap(excalRect.width);
      const excalH = snap(excalRect.height);
      const marginY = overdrawMarginPx(excalH, dpr);
      const height = excalH + 2 * marginY;
      canvas.style.left = `${snap(excalRect.left - boardRect.left - panX)}px`;
      canvas.style.top = `${snap(excalRect.top - boardRect.top - panY - marginY)}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      return { width, height, marginY };
    }, []);

    /**
     * Committed ink, tiled per zoom level. Live ink never enters it — see
     * {@link paintLiveIncremental}.
     */
    const tilesRef = useRef<InkTileCache | null>(null);
    const repaintPaintedRef = useRef<() => void>(() => {});
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
            if (drawingRef.current) {
              tilesDirtyRef.current = true;
              return;
            }
            // During a camera gesture the pan is a translate — a full clear-and-
            // blit would hitch the coast. When tiles have settled, repaint at
            // the painted base camera and keep the ride transform.
            if (cameraMovingRef.current) {
              if (tilesRef.current?.settled) {
                repaintPaintedRef.current();
              } else {
                tilesDirtyRef.current = true;
              }
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
      (
        viewport: ViewportTransform,
        cssW: number,
        visibleH: number,
        marginY = 0,
        preserveTransform = false,
      ) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const cssH = visibleH + 2 * marginY;
        const { pixelW, pixelH } = sizeCanvas(canvas, cssW, cssH, dpr);
        const view: ViewportTransform = { ...viewport, width: cssW, height: visibleH };
        const drawView = overdrawnViewport(view, marginY);
        // A paint is the thing a pan offset was standing in for. Whatever the
        // gesture had slid the bitmap to, these pixels are the honest answer at
        // `viewport`, and they belong at the layer's own coordinates — unless
        // this is a mid-gesture fill-in that must keep riding.
        if (!preserveTransform && canvas.style.transform) canvas.style.transform = "";

        const tiles = ensureTiles();
        tiles.setClip(clipRef.current);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pixelW, pixelH);
        tiles.draw(ctx, drawView, dpr);

        const hosts = scrollHostLookup();
        paintHostBoundPass(ctx, opsRef.current, hosts, drawView, dpr, clipRef.current);

        const live = liveRef.current;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (live) {
          syncLiveHostBinding(live);
          paintLiveOp(ctx, live, drawView, dpr, clipRef.current, hosts);
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
          height: visibleH,
          marginY,
          ops: opsRef.current.length,
          clip: clipRef.current,
          live: live !== null,
          settled: tiles.settled,
        };
      },
      [ensureTiles, sizeCanvas],
    );

    const paintFromBox = useCallback(
      (
        viewport: ViewportTransform,
        box: { width: number; height: number; marginY: number },
        preserveTransform = false,
      ) => {
        const marginY = box.marginY;
        const visibleH = box.height - 2 * marginY;
        paintFrame(viewport, box.width, visibleH, marginY, preserveTransform);
      },
      [paintFrame],
    );

    /** Full repaint of the overlay at the current (or frozen) camera. */
    const repaint = useCallback(() => {
      const canvas = canvasRef.current;
      // Prefer the stroke-start frame while a gesture is open (or just set up).
      const frozen = strokeViewRef.current;
      const box = strokeBoxRef.current;
      const viewport = frozen ?? getViewport();
      if (!canvas || !viewport || viewport.width < 1 || viewport.height < 1) return;
      if (frozen && box) {
        const marginY = box.marginY;
        const baseView: ViewportTransform = {
          ...frozen,
          scrollY: frozen.scrollY - marginY / frozen.zoom,
          height: frozen.height - 2 * marginY,
        };
        paintFromBox(baseView, box);
        return;
      }
      let excalRect = alignedBoxRef.current;
      if (!excalRect) {
        excalRect = alignToExcalidraw(canvas);
        alignedBoxRef.current = excalRect;
      }
      if (excalRect) {
        paintFromBox(viewport, excalRect);
      } else {
        paintFrame(viewport, viewport.width, viewport.height);
      }
    }, [alignToExcalidraw, getViewport, paintFrame, paintFromBox]);

    const repaintRef = useRef(repaint);
    repaintRef.current = repaint;

    /** Repaint at the last painted base camera, keeping a live-pan transform. */
    const repaintPainted = useCallback(() => {
      const painted = paintedViewRef.current;
      const canvas = canvasRef.current;
      if (!painted || !canvas) return;
      const liveViewport = getViewport();
      const viewport: ViewportTransform = {
        zoom: painted.zoom,
        scrollX: painted.scrollX,
        scrollY: painted.scrollY,
        offsetLeft: liveViewport?.offsetLeft ?? 0,
        offsetTop: liveViewport?.offsetTop ?? 0,
        width: painted.width,
        height: painted.height,
      };
      let box = alignedBoxRef.current;
      if (!box || box.marginY !== painted.marginY) {
        box = alignToExcalidraw(canvas);
        if (box) alignedBoxRef.current = box;
      }
      if (box) {
        paintFromBox(viewport, { ...box, marginY: painted.marginY }, true);
      } else {
        paintFrame(viewport, painted.width, painted.height, painted.marginY, true);
      }
    }, [alignToExcalidraw, getViewport, paintFrame, paintFromBox]);

    repaintPaintedRef.current = repaintPainted;

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
      if (excalRect) {
        paintFromBox(viewport, excalRect);
      } else {
        paintFrame(viewport, viewport.width, viewport.height);
      }
    }, [alignToExcalidraw, getViewport, paintFrame, paintFromBox]);

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
     * Hot path: full live redraw each frame under the stroke-start camera.
     *
     * Incremental tail paint stacked overlapping butt-cap segments into spoke
     * artifacts on thick pens; clearing and repainting the whole live op avoids
     * that without disturbing reshape/tip-lag callers.
     */
    const paintLiveIncremental = useCallback(() => {
      const canvas = canvasRef.current;
      const view = strokeViewRef.current;
      const box = strokeBoxRef.current;
      const live = liveRef.current;
      if (!canvas || !view || !box || !live || box.width < 1 || box.height < 1) return;
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

      syncLiveHostBinding(live);
      // Host-bound live ink needs clip+translate — fall back to a full frame.
      if (isHostBoundOp(live)) {
        repaint();
        return;
      }

      const marginY = box.marginY;
      const baseView: ViewportTransform = {
        ...view,
        scrollY: view.scrollY - marginY / view.zoom,
        height: view.height - 2 * marginY,
      };
      paintFromBox(baseView, box);
    }, [paintFromBox, repaint]);

    /**
     * True when open-stroke ink must be re-derived from raw stamps each paint.
     * Incremental paint cannot update earlier segments once they are stamped.
     */
    const liveReshapeActive = useCallback(() => {
      return (
        smoothingModeRef.current === "live" && smoothingRef.current > 0
      );
    }, []);

    /** Rebuild display points from the raw buffer; returns whether reshape ran. */
    const reshapeLiveStroke = useCallback(() => {
      const live = liveRef.current;
      const raw = liveRawPointsRef.current;
      if (!live || live.kind !== "draw" || !raw || !liveReshapeActive()) return false;
      live.points = smoothInkPoints(
        raw,
        smoothingRef.current,
        inkLineWidth(live.baseWidth, 0, false),
        0,
      );
      return true;
    }, [liveReshapeActive]);

    const paintLiveIncrementalRef = useRef(paintLiveIncremental);
    paintLiveIncrementalRef.current = paintLiveIncremental;
    const reshapeLiveStrokeRef = useRef(reshapeLiveStroke);
    reshapeLiveStrokeRef.current = reshapeLiveStroke;
    const liveReshapeActiveRef = useRef(liveReshapeActive);
    liveReshapeActiveRef.current = liveReshapeActive;
    const repaintLiveRef = useRef(repaint);
    repaintLiveRef.current = repaint;

    /** After appending stamps: reshape+full paint in live mode, else full live redraw. */
    const paintLiveAfterChange = useCallback(() => {
      if (reshapeLiveStrokeRef.current()) {
        liveDrawnIndexRef.current = 0;
        repaintLiveRef.current();
        return;
      }
      paintLiveIncrementalRef.current();
    }, []);
    const paintLiveAfterChangeRef = useRef(paintLiveAfterChange);
    paintLiveAfterChangeRef.current = paintLiveAfterChange;

    const commitLive = useCallback(() => {
      const live = liveRef.current;
      if (!live) return;

      /*
       * Stroke-eraser mode: the rub removes whole strokes rather than pixels.
       *
       * Taken before the undo snapshot below because it is a different *kind*
       * of edit — the page is a shorter list of ops afterwards, not the same
       * list with a mask painted over it. A rub that touched nothing is not an
       * edit at all and leaves the stack alone, so the writer's next undo does
       * something they can see rather than rolling back a wave of the hand.
       */
      if (live.kind === "erase" && !partialEraseRef.current) {
        const kept = opsAfterStrokeErase(opsRef.current, live);
        liveRef.current = null;
        liveRawPointsRef.current = null;
        liveDrawnIndexRef.current = 0;
        lastPointRef.current = null;
        rawPointRef.current = null;
        if (!kept) {
          repaint();
          return;
        }
        undoRef.current.push(snapshotOps(opsRef.current));
        if (undoRef.current.length > 40) {
          undoRef.current.splice(0, undoRef.current.length - 40);
        }
        redoRef.current = [];
        opsRef.current = kept;
        // Strokes vanished from under the page rather than being drawn over it,
        // so there is no tile to append to — the cache has to be rebuilt.
        tilesDirtyRef.current = true;
        repaint();
        onChange?.();
        return;
      }

      undoRef.current.push(snapshotOps(opsRef.current));
      // Cap undo depth — each snapshot clones every point, and erase stamps are dense.
      if (undoRef.current.length > 40) {
        undoRef.current.splice(0, undoRef.current.length - 40);
      }
      redoRef.current = [];

      /*
       * Smooth the pen stroke now that it is finished (lift mode).
       *
       * Live mode already reshaped the open stroke under the nib; re-running
       * here would jump ink the writer has already watched settle. The eraser
       * is left alone — its stamps are a coverage mask, not a line, and
       * rounding them would leave crumbs behind.
       */
      const isLive = smoothingModeRef.current === "live";
      const strength = smoothingRef.current;
      /*
       * Pressure strokes paint many translucent abutting runs. Storage RDP
       * (always-on 1/15-nib thin) drops samples on lift, runs regroup, and the
       * fill jumps — ugly on bold nibs. So they are still kept off the storage
       * floor: `minFraction 0` when smoothing is on, and the dial at zero means
       * the geometric pass is skipped entirely.
       *
       * What they no longer escape is `simplifyModulatedInkPoints`. Those
       * strokes used to be stored with *every* stamp — a point every 0.55 of a
       * nib, for the life of the document — and the argument for that only ever
       * covered points that carry modulation. A sample that sits on the line
       * between its neighbours in position, pressure *and* slowness carries
       * none: it cannot move a pixel, cannot shift a run boundary, and cannot
       * change the fill. Dropping those leaves the swell of the stroke exactly
       * where it was and takes out the pen sitting still.
       */
      const committed =
        live.kind === "draw" && !isLive
          ? (() => {
              const nib = inkLineWidth(live.baseWidth, 0, false);
              if (!live.pressureSensitive) {
                return {
                  ...live,
                  points: smoothInkPoints(live.points, strength, nib),
                };
              }
              const shaped =
                strength <= 0
                  ? live.points
                  : smoothInkPoints(live.points, strength, nib, 0);
              return {
                ...live,
                points: simplifyModulatedInkPoints(
                  shaped,
                  nib * SIMPLIFY_MODULATED_FRACTION,
                ),
              };
            })()
          : live;

      const bound = bindStrokeHost(committed);
      opsRef.current = [...opsRef.current, bound];
      liveRef.current = null;
      liveRawPointsRef.current = null;
      liveDrawnIndexRef.current = 0;
      lastPointRef.current = null;
      rawPointRef.current = null;

      // Only the tiles the stroke landed on are dropped, so committing on a
      // full page costs the same as committing on an empty one.
      ensureTiles().appendOp(bound);
      strokeHostRef.current = null;
      repaint();
      onChange?.();
    }, [ensureTiles, onChange, repaint]);

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
          liveRawPointsRef.current = null;
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
          liveRawPointsRef.current = null;
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
          liveRawPointsRef.current = null;
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
          liveRawPointsRef.current = null;
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
          const marginY = painted.marginY;
          const delta =
            marginY > 0
              ? panDelta(live, painted, { width: painted.width, height: painted.height }, PAN_REBASE_FRACTION, {
                  y: marginY * OVERDRAW_REBASE_HEADROOM,
                })
              : panDelta(live, painted, painted);
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
      const board = canvas?.closest(".lc-board");
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

    /**
     * Nested `scrollLeft` moves host-bound ink — repaint when any host scrolls.
     * Never during a live stroke: a full tile pass under the nib drops samples
     * and flickers committed ink.
     */
    useEffect(() => {
      if (!enabled) return;
      const board = canvasRef.current?.closest(".lc-board");
      if (!board) return;
      const hosts: HTMLElement[] = [];
      for (const doc of board.querySelectorAll(DOC_PAGE_SELECTOR)) {
        hosts.push(...horizontalScrollHostsIn(doc));
      }
      if (hosts.length === 0) return;
      let frame: number | null = null;
      const onScroll = () => {
        if (drawingRef.current) return;
        if (frame != null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (drawingRef.current) return;
          repaintRef.current();
        });
      };
      for (const host of hosts) {
        host.addEventListener("scroll", onScroll, { passive: true });
      }
      return () => {
        for (const host of hosts) {
          host.removeEventListener("scroll", onScroll);
        }
        if (frame != null) cancelAnimationFrame(frame);
      };
    }, [enabled, tool]);

    useEffect(() => {
      if (!enabled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      /** Window listeners are up because `setPointerCapture` was refused. */
      let windowFallback = false;
      /** Last move consumed, so the fallback and the canvas cannot double-stamp. */
      let lastHandledMove: PointerEvent | null = null;

      const clearDwellTimer = () => {
        if (dwellTimerRef.current !== null) {
          clearInterval(dwellTimerRef.current);
          dwellTimerRef.current = null;
        }
      };

      /** Stamp the attack buffer into live ink and clear the hold. */
      const flushAttackBuffer = () => {
        const buf = attackBufferRef.current;
        const live = liveRef.current;
        if (!buf || !live || live.kind !== "draw") return;
        const peak = attackPeakRef.current;
        for (const p of buf) {
          if (hasStylusPressure(p.pressure)) p.pressure = peak;
        }
        smoothedPressureRef.current = peak;
        attackBufferRef.current = null;

        const width = strokeWidthRef.current;
        const maxFullness = live.maxFullness;
        const pressureClip = live.pressureClip;
        const pressureSensitive = live.pressureSensitive;
        const speedInk = live.speedInk ?? 0;
        const boldness = live.boldness ?? inkBoldnessRef.current;

        const stamps: ScenePoint[] = [buf[0]];
        let last = buf[0];
        lastPointRef.current = last;
        rawPointRef.current = buf[buf.length - 1];

        for (let i = 1; i < buf.length; i++) {
          const point = buf[i];
          const style = inkStrokeStyle(
            width,
            maxFullness,
            point.pressure,
            pressureClip,
            pressureSensitive,
            0,
            point.slowness ?? INK_SLOWNESS_NEUTRAL,
            speedInk,
            false,
            boldness,
          );
          const dense =
            speedInk > 0 ||
            (pressureSensitive && hasStylusPressure(point.pressure));
          const step = Math.max(
            style.lineWidth * (dense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
            0.5,
          );
          stamps.push(...stampAlongSegment(last, point, step));
          last = point;
        }
        lastPointRef.current = last;
        if (liveReshapeActiveRef.current()) {
          liveRawPointsRef.current = stamps;
          live.points = stamps;
        } else {
          liveRawPointsRef.current = null;
          live.points = stamps;
        }
        paintLiveAfterChangeRef.current();
      };

      /**
       * Land the nib where the pen actually lifted.
       *
       * Tip-lag live mode left the ink a fraction of a time constant behind;
       * continuous reshape keeps endpoints on the pen, so this is a no-op then.
       * Kept for any residual last≠raw gap (e.g. dwell vs coalesced tip).
       */
      const settleLiveTip = () => {
        if (liveReshapeActiveRef.current()) return;
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
          false,
          live.boldness ?? inkBoldnessRef.current,
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
          clearDwellTimer();
          drawingRef.current = false;
          activePointerRef.current = null;
          if (attackBufferRef.current) flushAttackBuffer();
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
        const marginY = excalRect?.marginY ?? 0;
        const cssW = excalRect?.width ?? viewport.width;
        const visibleH = excalRect ? excalRect.height - 2 * marginY : viewport.height;
        const cssH = visibleH + 2 * marginY;
        const strokeView: ViewportTransform = overdrawnViewport(
          { ...viewport, width: cssW, height: visibleH },
          marginY,
        );
        strokeViewRef.current = strokeView;
        strokeBoxRef.current = { width: cssW, height: cssH, marginY };

        const rect = canvas.getBoundingClientRect();
        strokeRectRef.current = rect;
        /*
         * Host under the nib, not under `event.target`.
         *
         * Annotate lands on the ink canvas (doc is pointer-events: none), so
         * walking from the target never finds a scroll host. Point-hit the DOM
         * under the canvas the same way DocSelectionLayer does for selection.
         */
        const hostEl = scrollHostAtPoint(event.clientX, event.clientY);
        if (hostEl) {
          const doc = docForScrollHost(hostEl);
          const key = doc ? hostKeyInDoc(hostEl, doc) : null;
          if (key == null) {
            strokeHostRef.current = null;
          } else {
            const listed = collectScrollHosts().find((host) => host.key === key);
            strokeHostRef.current =
              listed ??
              ({
                key,
                scrollLeft: hostEl.scrollLeft,
                bounds: hostSceneBounds(hostEl, rect, strokeView),
              } satisfies ScrollHostPaintState);
          }
        } else {
          strokeHostRef.current = null;
        }
        const point = scenePointFromPointer(
          event.clientX,
          event.clientY,
          rect,
          strokeView,
          event.pressure,
          event.pointerType,
        );
        const speed = speedInkRef.current;
        const blotBlend = speedBlotBlendRef.current;
        const boldness = inkBoldnessRef.current;
        // Start at the neutral pace rather than at rest: the nib has no history
        // yet, and seeding it "stopped" would open every stroke with a blob.
        if (speed > 0) point.slowness = INK_SLOWNESS_NEUTRAL;
        lastPointRef.current = point;
        rawPointRef.current = point;
        smoothedPressureRef.current = hasStylusPressure(point.pressure) ? point.pressure : 0;
        smoothedSpeedRef.current = speed > 0 ? INK_SPEED_NEUTRAL_PX_MS : 0;
        lastSampleTimeRef.current = event.timeStamp;
        lastMoveWallRef.current = performance.now();
        dwellCountRef.current = 0;
        clearDwellTimer();
        if (DEBUG_INK) inkMetrics.begin();
        const width = strokeWidthRef.current;
        /*
         * The pen's dial is in screen pixels; the eraser's is not, and should
         * not be — its ring is already drawn in screen pixels and erases
         * exactly what it covers, so the two agree at any zoom. The nib had no
         * such agreement: a document opens fitted to a reading column and a pad
         * does not, so the same setting wrote visibly fatter on the document.
         */
        const penWidth = inkBaseWidthForZoom(width, strokeView.zoom);
        const activeTool = toolRef.current;
        const pressureSensitive = pressureSensitiveRef.current;
        const attackApplies =
          activeTool === "pen" &&
          pressureSensitive &&
          hasStylusPressure(point.pressure);
        if (activeTool === "highlighter") {
          /*
           * A chisel: no attack buffer, no reservoir, no pressure, no pace.
           * `inkStrokeStyle` short-circuits all of it on the `highlight` flag —
           * the fields below are only carried so the op stays one shape.
           */
          attackBufferRef.current = null;
          liveRawPointsRef.current = liveReshapeActiveRef.current() ? [point] : null;
          liveRef.current = {
            kind: "draw",
            color: inkColorRef.current,
            baseWidth: penWidth,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            speedInk: 0,
            highlight: true,
            points: [point],
          };
          liveDrawnIndexRef.current = 0;
        } else if (activeTool === "pen") {
          if (attackApplies) {
            attackBufferRef.current = [point];
            attackPeakRef.current = point.pressure;
            attackStartRef.current = event.timeStamp;
            attackCountRef.current = 1;
            liveRef.current = {
              kind: "draw",
              color: inkColorRef.current,
              baseWidth: penWidth,
              // Top of dial stores 0.999 so a paragraph still dries; exactly 1
              // is reserved for pressure-off (no reservoir).
              maxFullness: pressureSensitive
                ? Math.min(inkFullnessRef.current, 0.999)
                : 1,
              pressureClip: pressureClipRef.current,
              pressureSensitive,
              speedInk: speed,
              ...(speed > 0 ? { speedBlotBlend: blotBlend } : {}),
              boldness,
              points: [],
            };
            liveRawPointsRef.current = liveReshapeActiveRef.current() ? [] : null;
          } else {
            attackBufferRef.current = null;
            liveRawPointsRef.current = liveReshapeActiveRef.current()
              ? [point]
              : null;
            liveRef.current = {
              kind: "draw",
              color: inkColorRef.current,
              baseWidth: penWidth,
              maxFullness: pressureSensitive
                ? Math.min(inkFullnessRef.current, 0.999)
                : 1,
              pressureClip: pressureClipRef.current,
              pressureSensitive,
              speedInk: speed,
              ...(speed > 0 ? { speedBlotBlend: blotBlend } : {}),
              boldness,
              points: [point],
            };
          }
          liveDrawnIndexRef.current = 0;
        } else {
          attackBufferRef.current = null;
          liveRawPointsRef.current = null;
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
          painted.scrollY === strokeView.scrollY - marginY / strokeView.zoom &&
          painted.width === cssW &&
          painted.height === visibleH &&
          painted.marginY === marginY;
        if (!reusable) repaintRef.current();
        drawingRef.current = true;
        activePointerRef.current = event.pointerId;
        const liveAfterBegin = liveRef.current;
        if (
          liveAfterBegin &&
          ((liveAfterBegin.kind === "draw" && liveAfterBegin.points.length > 0) ||
            liveAfterBegin.kind === "erase")
        ) {
          paintLiveAfterChangeRef.current();
        }
        if (activeTool === "pen" && speed > 0) {
          dwellTimerRef.current = setInterval(() => {
            if (!drawingRef.current) return;
            if (attackBufferRef.current) return;
            const liveOp = liveRef.current;
            if (!liveOp || liveOp.kind !== "draw" || (liveOp.speedInk ?? 0) <= 0) return;
            if (liveOp.points.length === 0) return;
            if (performance.now() - lastMoveWallRef.current < 60) return;
            if (dwellCountRef.current >= 40) return;
            dwellCountRef.current++;
            smoothedSpeedRef.current = smoothSpeed(smoothedSpeedRef.current, 0);
            const last = lastPointRef.current;
            if (!last) return;
            const dwellPoint: ScenePoint = {
              ...last,
              slowness: inkSlowness(smoothedSpeedRef.current),
            };
            if (liveOp.pressureSensitive && hasStylusPressure(last.pressure)) {
              dwellPoint.pressure = smoothedPressureRef.current;
            }
            const dwellWidth = strokeWidthRef.current;
            const dwellStyle = inkStrokeStyle(
              dwellWidth,
              liveOp.maxFullness,
              dwellPoint.pressure,
              liveOp.pressureClip,
              liveOp.pressureSensitive,
              0,
              dwellPoint.slowness ?? INK_SLOWNESS_NEUTRAL,
              liveOp.speedInk ?? 0,
              false,
              liveOp.boldness ?? inkBoldnessRef.current,
            );
            const dwellDense =
              (liveOp.speedInk ?? 0) > 0 ||
              (liveOp.pressureSensitive && hasStylusPressure(dwellPoint.pressure));
            const dwellStep = Math.max(
              dwellStyle.lineWidth *
                (dwellDense ? INK_STEP_FACTOR_PRESSURE : INK_STEP_FACTOR),
              0.5,
            );
            const dwellStamps = stampAlongSegment(last, dwellPoint, dwellStep);
            if (liveReshapeActiveRef.current()) {
              const raw = liveRawPointsRef.current ?? (liveRawPointsRef.current = []);
              raw.push(...dwellStamps);
            } else {
              liveOp.points.push(...dwellStamps);
            }
            lastPointRef.current = dwellPoint;
            paintLiveAfterChangeRef.current();
          }, 32);
        }
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
        const reshapeLive =
          live.kind === "draw" && liveReshapeActiveRef.current();
        const zoom = strokeView.zoom || 1;

        if (attackBufferRef.current && live.kind === "draw") {
          for (const sample of batch) {
            const rawLast = rawPointRef.current;
            if (!rawLast) break;
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
            lastMoveWallRef.current = performance.now();
            dwellCountRef.current = 0;

            if (pressureSensitive && hasStylusPressure(raw.pressure)) {
              if (raw.pressure > attackPeakRef.current) {
                attackPeakRef.current = raw.pressure;
              }
              smoothedPressureRef.current = smoothPressure(
                smoothedPressureRef.current,
                raw.pressure,
              );
              raw.pressure = smoothedPressureRef.current;
            } else {
              raw.pressure = NO_PRESSURE;
            }

            if (speedInk > 0) {
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
            attackBufferRef.current.push(raw);
            attackCountRef.current++;
          }

          const shouldFlush =
            event.timeStamp - attackStartRef.current >= INK_ATTACK_MS ||
            attackCountRef.current >= 3;
          if (shouldFlush) flushAttackBuffer();
          if (attackBufferRef.current) return;
          return;
        }

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
          lastMoveWallRef.current = performance.now();
          dwellCountRef.current = 0;

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

          // Tip tracks the pen. Live reshape tidies earlier points on paint;
          // lift mode keeps raw stamps until commit.
          const point = raw;

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
                    live.kind === "draw" && live.highlight === true,
                    live.kind === "draw" ? (live.boldness ?? inkBoldnessRef.current) : 1,
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
          if (reshapeLive) {
            const rawBuf =
              liveRawPointsRef.current ?? (liveRawPointsRef.current = []);
            rawBuf.push(...stamps);
          } else {
            live.points.push(...stamps);
          }
          lastPointRef.current = point;
        }
        paintLiveAfterChangeRef.current();
        if (DEBUG_INK) inkMetrics.painted(event.timeStamp);
      };

      const end = (event: PointerEvent) => {
        if (!drawingRef.current) return;
        // A palm lifting off is not the pen lifting off.
        if (event.pointerId !== activePointerRef.current) return;
        clearDwellTimer();
        if (attackBufferRef.current) flushAttackBuffer();
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
        clearDwellTimer();
        attackBufferRef.current = null;
        liveRawPointsRef.current = null;
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
        clearDwellTimer();
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
      <div className="lc-raster-ink-clip">
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
      </div>
    );
  },
);

function isCanvasTarget(target: EventTarget | null, layer: HTMLCanvasElement): boolean {
  return target === layer;
}
