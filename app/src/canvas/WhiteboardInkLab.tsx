/**
 * Whiteboard drawing surface. Attach / down / move / up / paint through
 * {@link ./inkLab/engine.ts}. Board chrome maps onto the WebGL nib
 * (size, colour, pressure, hold grow, lift smoothing, straight).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import { WHEEL_OPEN_MS } from "../util/gesture";
import { sashDragActive } from "../util/splitResize";
import { isLoadingDoodleActive } from "../util/loadingDoodleActivity";
import { yieldToInput } from "../util/cameraBusy";
import { wheelHoldIsDrawingHop, wheelHoldOutcome, wheelHoldTurn } from "../util/inkToolPresets";
import { thinInkPointsForStorage } from "./inkSmoothing";
import { InkPageBook } from "./inkPageCache";
import { HostInkRasterCache, InkGeometrySnapshot } from "./inkLab/hostRaster";
import { pageIdAtViewport, type PageFrame } from "./inkPageIndex";
import { InkTileCache, inkOpBounds } from "./inkTiles";
import { canvasBitmapFromClient } from "./canvasPointer";
import { commitOverlay, dropRedoStacks, pushCapped, redoOverlay, undoOverlay } from "./inkLab/history";
import { isInkLabPenOp } from "./inkLab/replay";
import { appendErasePathPoint } from "./strokeEraser";
import { bakeSpineOffThread } from "./inkLab/bakeClient";
import {
  inkCanvasPixelsChanged,
  inkCanvasCssMatches,
  idleRemeshAfterStrokeMs,
  remeshOnHostBoundLift,
  instantReplayOnBackingResize,
  instantReplayOnCameraRebase,
  instantReplayOnFirstPresent,
  instantReplayOnPageWindow,
  instantReplayOnPointerDown,
  finishReplayWhileDrawing,
  instantReplayOnUndo,
  keepLivePaintPump,
  mutationIsInkChrome,
  pageStageMatchesCanvas,
  remeshOnCameraMovingEnd,
  remeshOnNestedHostScroll,
  samePaintedView,
  shouldFlushLiveHud,
  skipCommittedReplay,
  skipHostBoundPresentWhileCameraBusy,
  skipReplayOnWheelAbort,
  usePreStrokeStamp,
} from "./inkLab/liveHost";
import {
  livePresentStride,
  medianMs,
  resolveDisplayHz,
  shouldCompositeLive,
  vsyncMsForHz,
  type InkDisplayHzPref,
} from "./inkLab/displayHz";
import {
  createInkLabEngine,
  type InkLabEngine,
  type InkLabSample,
  type InkLabSnapPatch,
  type InkLabUpResult,
} from "./inkLab/engine";
import { createInkLabHudStats, INK_LAB_HUD_ZERO } from "./inkLab/hud";
import { peekInkTileMetrics } from "./inkTileMetrics";
import type { SpineDot } from "./inkLab/instance";
import { labPenFromToolbar } from "./inkLab/style";
import { createInkLoadMeter } from "./inkLoadMeter";
import { InkLoadBar, type InkLoadBarHandle } from "./InkLoadBar";
import {
  highlighterChiselWidth,
  highlighterDrawOp,
  inkBaseWidthForZoom,
  inkLineWidth,
  isHostBoundOp,
  eraserCanvasRadius,
  eraserPageWidth,
  eraserSceneRadius,
  paintHostBoundOps,
  paintRasterInk,
  scenePointFromCanvasPixel,
  setInkSceneTransform,
  trimHighlightLiftHook,
  inkOpsBounds,
  inkPaintClip,
  type InkBlotHalt,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ScenePoint,
  type ScrollHostLookup,
  type ViewportTransform,
} from "./rasterInk";
import {
  DOC_PAGE_SELECTOR,
  boxedScrollHostsInBoard,
  hitScrollHostAtBoxes,
  hostSceneBoundsFromClientBox,
  invalidateBoardScrollHostLayout,
  listScrollHostsInBoard,
  rememberBoardScrollHosts,
  mergeHostScrollSnapshots,
  pickSettledHostScroll,
  restoreListedHostScroll,
  snapshotListedHostScroll,
  mutationAffectsScrollHosts,
  restoreDroppedHostScroll,
  snapshotHostScrollIn,
  upsertHostScrollSnapshot,
  type HostScrollSnapshot,
  type ScrollHostPaintState,
} from "./scrollHost";
import {
  OVERDRAW_REBASE_HEADROOM,
  PAN_REBASE_FRACTION,
  overdrawMarginPx,
  overdrawnViewport,
  inkInputViewport,
  panDelta,
  type PanCamera,
} from "./panOffset";
import { straightAnchorFor } from "./straightAnchor";
export interface RasterInkHandle {
  clear(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  hasInk(): boolean;
  isDrawing(): boolean;
  repaint(): void;
  replayCommitted(onlyHostBound?: boolean): void;
  /** Slice the first paint after restore so loading overlay drop cannot ANR. */
  primeSnap(): Promise<void>;
  syncCamera(allowPaused?: boolean): void | Promise<void>;
  setPanOffset(live: PanCamera | null): boolean;
  commitCamera(): void;
  setCameraMoving(moving: boolean): void;
  /** Tool changes stop pan bookkeeping without pretending to be a camera settle. */
  cancelCameraMotion(): void;
  getOps(): InkOp[];
  setOps(ops: readonly InkOp[], opts?: { paint?: boolean }): void;
  getOpCount(): number;
  getRevision(): number;
  dirtyInkPageCount(): number;
  takeDirtyInkPages(): Map<number, import("./inkCodec").EncodedInk>;
  snapshotInkPages(): Map<number, import("./inkCodec").EncodedInk>;
  markInkPagesFlushed(pageIds: Iterable<number>): void;
  ingestInkPages(
    pages: Map<number, import("./inkCodec").EncodedInk>,
    opts?: { paint?: boolean },
  ): void;
  assembleEncoded(): import("./inkCodec").EncodedInk;
  encodedShards(): import("./inkCodec").EncodedInk[];
  inkPageIds(): number[];
  seedColdInkPages(pages: Iterable<[number, import("./inkCodec").EncodedInk]>): void;
}

export interface WhiteboardInkLabProps {
  enabled: boolean;
  /** Loading owns first paint; camera fits under the spinner must not force an atomic book replay. */
  preparing?: boolean;
  splitPaused?: boolean;
  tool: "pen" | "eraser" | "highlighter" | null;
  strokeWidth: number;
  inkColor: string;
  pressureClip: number;
  pressureSensitive: boolean;
  smoothing?: number;
  smoothingMode?: "lift" | "live";
  clothoid?: boolean;
  capillary?: boolean;
  straightInk?: boolean;
  speedInk?: number;
  speedBlotBlend?: number;
  speedFade?: number;
  highlightTips?: boolean;
  getViewport: () => ViewportTransform | null;
  clip?: SceneBounds | null;
  /** PDF / notebook page frames in scene Y, or empty → single-page fallback. */
  getPageFrames?: () => readonly PageFrame[];
  onChange?: () => void;
  onStylusAccessory?: (event: PointerEvent) => boolean;
  wheelHoldEnabled?: boolean;
  onWheelHold?: (clientX: number, clientY: number) => void;
  /** Pixel rub vs drop whole strokes. Default matches the writer pref. */
  partialErase?: boolean;
  perfOverlay?: boolean;
  perfBar?: boolean;
  /** Auto / 60 / 90 / 120 / 240 — HUD vsync and live present cap. */
  displayHz?: InkDisplayHzPref;
  /** Present every dirty vsync. Off keeps the 60fps cap on 90Hz+. */
  matchDisplay?: boolean;
}

function fallbackViewport(width: number, height: number): ViewportTransform {
  return {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    offsetLeft: 0,
    offsetTop: 0,
    width,
    height,
  };
}

type PaintedLabView = PanCamera & { width: number; height: number; marginY: number };

function cloneOps(ops: readonly InkOp[]): InkOp[] {
  return ops.map((op) => ({ ...op, points: [...op.points] }));
}

function sampleOf(canvas: HTMLCanvasElement, event: PointerEvent): InkLabSample {
  const { x, y } = canvasBitmapFromClient(canvas, event.clientX, event.clientY);
  const pressure =
    event.pointerType === "pen" && Number.isFinite(event.pressure)
      ? event.pressure
      : 0.5;
  return {
    x,
    y,
    p: pressure,
    t: event.timeStamp,
  };
}

function highlightPointOf(
  canvas: HTMLCanvasElement,
  event: PointerEvent,
  paintView: ViewportTransform,
): ScenePoint {
  const { x, y } = canvasBitmapFromClient(canvas, event.clientX, event.clientY);
  const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
  const scene = scenePointFromCanvasPixel(x / dpr, y / dpr, paintView);
  return { x: scene.x, y: scene.y, pressure: 0.5 };
}

function liveHighlightPoints(
  points: readonly ScenePoint[],
  straight: boolean,
): ScenePoint[] {
  if (straight && points.length >= 2) return [points[0]!, points[points.length - 1]!];
  return points.slice();
}

function spineToScene(
  dots: readonly SpineDot[],
  view: ViewportTransform,
  dpr: number,
): ScenePoint[] {
  const overlayScale = Math.max(1e-6, view.zoom * dpr);
  return dots.map((d) => {
    const scene = scenePointFromCanvasPixel(d.x / dpr, d.y / dpr, view);
    const pt: ScenePoint = {
      x: scene.x,
      y: scene.y,
      pressure: d.p ?? 0.5,
      radius: d.r / overlayScale,
    };
    if (d.slow != null) pt.slowness = d.slow;
    return pt;
  });
}

function paintInkStamps(
  sctx: CanvasRenderingContext2D,
  paintView: ViewportTransform,
  ops: readonly InkOp[],
  dpr: number,
  clip: SceneBounds | null,
  hosts: ScrollHostLookup,
): void {
  paintRasterInk(sctx, paintView, ops, null, dpr, clip, false);
  paintHostBoundLayer(sctx, paintView, ops, dpr, clip, hosts);
}

function paintHostBoundLayer(
  sctx: CanvasRenderingContext2D,
  paintView: ViewportTransform,
  ops: readonly InkOp[],
  dpr: number,
  clip: SceneBounds | null,
  hosts: ScrollHostLookup,
): void {
  if (hosts.size === 0 && !ops.some((op) => isHostBoundOp(op))) return;
  setInkSceneTransform(sctx, paintView, dpr);
  if (clip) {
    sctx.save();
    sctx.beginPath();
    sctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    sctx.clip();
  }
  paintHostBoundOps(sctx, ops, hosts, paintView.zoom * dpr, undefined, paintView.zoom);
  if (clip) sctx.restore();
}

function capturePageStage(
  pageRef: { current: HTMLCanvasElement | null },
  stage: HTMLCanvasElement,
): void {
  let page = pageRef.current;
  if (!page) {
    page = document.createElement("canvas");
    pageRef.current = page;
  }
  if (page.width !== stage.width) page.width = stage.width;
  if (page.height !== stage.height) page.height = stage.height;
  const pctx = page.getContext("2d");
  if (!pctx) return;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.globalCompositeOperation = "copy";
  pctx.drawImage(stage, 0, 0);
  pctx.globalCompositeOperation = "source-over";
}

function bindInkOpToHost<T extends InkOp>(op: T, host: ScrollHostPaintState | null): T {
  if (!host) return op;
  return {
    ...op,
    hostKey: host.key,
    scrollLeftAtDraw: host.scrollLeft,
    scrollTopAtDraw: host.scrollTop,
  };
}

function opFromBake(
  baked: InkLabUpResult,
  view: ViewportTransform,
  dpr: number,
  color: string,
  uiWidth: number,
  pressureClip: number,
  pressureSensitive: boolean,
  speedFade: number,
  smoothing = 0,
): InkDrawOp {
  const baseWidth = inkBaseWidthForZoom(uiWidth, view.zoom);
  const scene = spineToScene(baked.points, view, dpr);
  const op: InkDrawOp = {
    kind: "draw",
    color,
    baseWidth,
    maxFullness: 1,
    pressureClip,
    pressureSensitive,
    points:
      smoothing > 0
        ? thinInkPointsForStorage(scene, inkLineWidth(baseWidth, 0, false))
        : scene,
  };
  if (baked.blotTipGrow > 0) op.blotTipGrow = baked.blotTipGrow;
  if (speedFade > 1e-6) op.speedFade = speedFade;
  if (baked.blotHalts.length > 0) {
    op.blotHalts = baked.blotHalts.map((h): InkBlotHalt => {
      const scene = scenePointFromCanvasPixel(h.x / dpr, h.y / dpr, view);
      return {
        x: scene.x,
        y: scene.y,
        grow: h.grow,
        ...(h.p != null ? { pressure: h.p } : {}),
        ...(h.slow != null ? { slowness: h.slow } : {}),
      };
    });
  }
  return op;
}

export const WhiteboardInkLab = forwardRef<RasterInkHandle, WhiteboardInkLabProps>(
  function WhiteboardInkLab(
    {
      enabled,
      preparing = false,
      splitPaused = false,
      tool,
      strokeWidth,
      inkColor,
      pressureClip,
      pressureSensitive,
      smoothing,
      smoothingMode = "lift",
      clothoid = false,
      capillary = false,
      straightInk = false,
      speedInk = 0,
      speedBlotBlend = 0,
      speedFade = 0,
      highlightTips = false,
      getViewport,
      clip = null,
      getPageFrames,
      onChange,
      onStylusAccessory,
      wheelHoldEnabled = false,
      onWheelHold,
      partialErase = true,
      perfOverlay = false,
      perfBar = false,
      displayHz = "auto",
      matchDisplay = false,
    }: WhiteboardInkLabProps,
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<InkLabEngine | null>(null);
    const engineWaitersRef = useRef<Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }>>([]);
    const primeSnapRef = useRef<Promise<void> | null>(null);
    const tilesRef = useRef<InkTileCache | null>(null);
    const tileStageRef = useRef<HTMLCanvasElement | null>(null);
    const pageStageRef = useRef<HTMLCanvasElement | null>(null);
    const pageGeometryRef = useRef(new InkGeometrySnapshot());
    const hostRasterRef = useRef(new HostInkRasterCache());
    const presentedHostsRef = useRef<ScrollHostLookup>(new Map());
    const tileReadyRef = useRef<() => void>(() => {});
    const committedBuildRef = useRef(false);
    const bookRef = useRef(new InkPageBook());
    const overlayRef = useRef<SpineDot[][]>([]);
    const overlayRedoRef = useRef<SpineDot[][]>([]);
    const snapUndoRef = useRef<(InkLabSnapPatch | null)[]>([]);
    const snapRedoRef = useRef<(InkLabSnapPatch | null)[]>([]);
    const pendingStampPatchRef = useRef<InkLabSnapPatch | null>(null);
    const drawingRef = useRef(false);
    const strokeHostRef = useRef<ScrollHostPaintState | null>(null);
    const strokeHostElRef = useRef<HTMLElement | null>(null);
    const strokeHostPinRef = useRef<HostScrollSnapshot | null>(null);
    const nestedHostsRef = useRef<{ el: HTMLElement; doc: number; key: number }[] | null>(null);
    const replayNeededAfterStrokeRef = useRef(false);
    const idleRemeshTimerRef = useRef<number | null>(null);
    const lastHostScrollRef = useRef<HostScrollSnapshot[]>([]);
    const highlightPtsRef = useRef<ScenePoint[] | null>(null);
    const erasePtsRef = useRef<ScenePoint[] | null>(null);
    const rafRef = useRef<number | null>(null);
    const replayRafRef = useRef<number | null>(null);
    const replayGenRef = useRef(0);
    const historyFrameRef = useRef<number | null>(null);
    const historyPixelsDirtyRef = useRef(false);
    const replayWaitersRef = useRef<Array<() => void>>([]);
    const shiftAnchorRef = useRef<number | null>(null);
    const holdTimerRef = useRef<number | null>(null);
    const pendingHoldRef = useRef<{
      pointerId: number;
      down: PointerEvent;
      opened: boolean;
      decided: boolean;
      pathPx: number;
      moves: number;
      windRad: number;
      lastStepX: number;
      lastStepY: number;
      lastX: number;
      lastY: number;
    } | null>(null);

    const toolRef = useRef(tool);
    toolRef.current = tool;
    const preparingRef = useRef(preparing);
    preparingRef.current = preparing;
    const splitPausedRef = useRef(false);
    splitPausedRef.current = splitPaused && !preparing;
    const replayAllowPausedRef = useRef(false);
    const partialEraseRef = useRef(partialErase);
    partialEraseRef.current = partialErase;
    const strokeWidthRef = useRef(strokeWidth);
    strokeWidthRef.current = strokeWidth;
    const inkColorRef = useRef(inkColor);
    inkColorRef.current = inkColor;
    const pressureClipRef = useRef(pressureClip);
    pressureClipRef.current = pressureClip;
    const pressureSensitiveRef = useRef(pressureSensitive);
    pressureSensitiveRef.current = pressureSensitive;
    const smoothingRef = useRef(smoothing);
    smoothingRef.current = smoothing;
    const smoothingModeRef = useRef(smoothingMode);
    smoothingModeRef.current = smoothingMode;
    const clothoidRef = useRef(clothoid);
    clothoidRef.current = clothoid;
    const capillaryRef = useRef(capillary);
    capillaryRef.current = capillary;
    const speedInkRef = useRef(speedInk);
    speedInkRef.current = speedInk;
    const blotRef = useRef(speedBlotBlend);
    blotRef.current = speedBlotBlend;
    const speedFadeRef = useRef(speedFade);
    speedFadeRef.current = speedFade;
    const highlightTipsRef = useRef(highlightTips);
    highlightTipsRef.current = highlightTips;
    const straightInkRef = useRef(straightInk);
    straightInkRef.current = straightInk;
    const getViewportRef = useRef(getViewport);
    getViewportRef.current = getViewport;
    const getPageFramesRef = useRef(getPageFrames);
    getPageFramesRef.current = getPageFrames;
    const clipRef = useRef(clip);
    clipRef.current = clip;
    const eraserPageW = () =>
      eraserPageWidth(
        clipRef.current ? clipRef.current.maxX - clipRef.current.minX : undefined,
      );
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onStylusAccessoryRef = useRef(onStylusAccessory);
    onStylusAccessoryRef.current = onStylusAccessory;
    const wheelHoldEnabledRef = useRef(wheelHoldEnabled);
    wheelHoldEnabledRef.current = wheelHoldEnabled;
    const onWheelHoldRef = useRef(onWheelHold);
    onWheelHoldRef.current = onWheelHold;
    const perfOverlayRef = useRef(perfOverlay);
    perfOverlayRef.current = perfOverlay;
    const perfBarRef = useRef(perfBar);
    perfBarRef.current = perfBar;
    const displayHzRef = useRef(displayHz);
    displayHzRef.current = displayHz;
    const matchDisplayRef = useRef(matchDisplay);
    matchDisplayRef.current = matchDisplay;
    const loadMeterRef = useRef(createInkLoadMeter());
    const loadBarRef = useRef<InkLoadBarHandle>(null);
    const hudStatsRef = useRef(createInkLabHudStats());
    const lastRafRef = useRef(0);
    const bakeRef = useRef({ bakeMs: 0, bake: "catmull" });
    const backendRef = useRef("none");
    const marginYRef = useRef(0);
    const paintedViewRef = useRef<PaintedLabView | null>(null);
    const cameraMovingRef = useRef(false);
    const lastStrokeAtRef = useRef(-Infinity);
    const sizeToHostRef = useRef<(allowPaused?: boolean, paint?: boolean) => void>(() => {});

    const ensureTiles = useCallback(() => {
      if (!tilesRef.current) {
        tilesRef.current = new InkTileCache({
          onTilesReady: () => tileReadyRef.current(),
          useWorker: true,
          persist: true,
          pause: () => drawingRef.current ||
            performance.now() - lastStrokeAtRef.current < idleRemeshAfterStrokeMs() || sashDragActive() ||
            (splitPausedRef.current && !replayAllowPausedRef.current),
        });
      }
      return tilesRef.current;
    }, []);

    const readViews = useCallback(() => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const marginY = marginYRef.current;
      const raw = getViewportRef.current();
      /*
       * Cover the ink host, not Excalidraw's appState box. A stale smaller
       * width/height left a strip of canvas with no tiles — the screen cutting
       * writing at the edge. RasterInkLayer sizes the same way.
       */
      const width = Math.max(1, host?.clientWidth || raw?.width || 1);
      const height = Math.max(1, host?.clientHeight || raw?.height || 1);
      const view = raw
        ? { ...raw, width, height }
        : fallbackViewport(width, height);
      const dpr = canvas
        ? canvas.width / Math.max(1, canvas.clientWidth || canvas.width)
        : 1;
      return {
        view,
        paintView: overdrawnViewport(view, marginY),
        dpr,
        marginY,
      };
    }, []);

    const boardRoot = useCallback((): Element | null => {
      return (
        canvasRef.current?.closest(".lc-board") ??
        hostRef.current?.closest(".lc-board") ??
        null
      );
    }, []);

    const fillNestedHosts = useCallback((board: Element) => {
      const listed = listScrollHostsInBoard(board);
      nestedHostsRef.current = listed;
      rememberBoardScrollHosts(board, listed);
    }, []);

    const collectScrollHosts = useCallback((): readonly ScrollHostPaintState[] => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const board = canvas.closest(".lc-board");
      if (!board) return [];
      const { paintView, marginY } = readViews();
      // Paint at the live camera, even while the old bitmap is CSS-translated.
      // Its client rect belongs to the old pixels and would shift host clips
      // a second time. The stationary wrapper is the new bitmap's origin.
      const wrapper = hostRef.current!.getBoundingClientRect();
      const rect = { left: wrapper.left, top: wrapper.top - marginY };
      return boxedScrollHostsInBoard(board).map((host) => ({
        key: host.key,
        scrollLeft: host.el.scrollLeft,
        scrollTop: host.el.scrollTop,
        bounds: hostSceneBoundsFromClientBox(host, rect, paintView),
      }));
    }, [readViews]);

    const scrollHostLookup = useCallback((): ScrollHostLookup => {
      const map = new Map<number, { bounds: SceneBounds; scrollLeft: number; scrollTop: number }>();
      for (const host of collectScrollHosts()) {
        map.set(host.key, {
          bounds: host.bounds,
          scrollLeft: host.scrollLeft,
          scrollTop: host.scrollTop,
        });
      }
      return map;
    }, [collectScrollHosts]);

    const holdNestedScroll = useCallback(() => {
      const board = boardRoot();
      if (!board) return;
      if (!nestedHostsRef.current || nestedHostsRef.current.some(h => !h.el.isConnected)) fillNestedHosts(board);
      const pin = strokeHostPinRef.current;
      const el = restoreListedHostScroll(nestedHostsRef.current ?? [], lastHostScrollRef.current, pin);
      if (el) strokeHostElRef.current = el;
    }, [boardRoot, fillNestedHosts]);

    const captureStrokeHost = useCallback(
      (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        const board = boardRoot();
        const clear = () => {
          strokeHostRef.current = null;
          strokeHostElRef.current = null;
          strokeHostPinRef.current = null;
        };
        if (!canvas || !board) {
          clear();
          return;
        }
        if (!nestedHostsRef.current) fillNestedHosts(board);
        let listed = (nestedHostsRef.current ?? []).filter((h) => h.el.isConnected);
        if (listed.length !== (nestedHostsRef.current?.length ?? 0)) {
          nestedHostsRef.current = listed;
          rememberBoardScrollHosts(board, listed);
          if (listed.length === 0) {
            fillNestedHosts(board);
            listed = nestedHostsRef.current ?? [];
          }
        }
        if (listed.length === 0) {
          clear();
          return;
        }
        const hit = hitScrollHostAtBoxes(
          clientX,
          clientY,
          boxedScrollHostsInBoard(board),
        );
        if (!hit) {
          clear();
          return;
        }
        const hostEl = hit.el;
        const live = {
          doc: hit.doc,
          key: hit.key,
          left: hostEl.scrollLeft,
          top: hostEl.scrollTop,
        };
        const remembered = lastHostScrollRef.current.find(
          (s) => s.doc === live.doc && s.key === live.key,
        );
        const pin = pickSettledHostScroll(live, remembered);
        if (hostEl.scrollLeft !== pin.left) hostEl.scrollLeft = pin.left;
        if (hostEl.scrollTop !== pin.top) hostEl.scrollTop = pin.top;
        const pinnedEl = hostEl;
        lastHostScrollRef.current = upsertHostScrollSnapshot(lastHostScrollRef.current, pin);
        strokeHostPinRef.current = pin;
        strokeHostElRef.current = pinnedEl;
        const { paintView } = readViews();
        const canvasRect = canvas.getBoundingClientRect();
        const pinnedBox =
          pinnedEl === hostEl
            ? hit
            : pinnedEl.getBoundingClientRect();
        strokeHostRef.current = {
          key: pin.key,
          scrollLeft: pin.left,
          scrollTop: pin.top,
          bounds: hostSceneBoundsFromClientBox(pinnedBox, canvasRect, paintView),
        };
      },
      [boardRoot, fillNestedHosts, readViews],
    );

    const settleReplayWaiters = () => {
      const waiters = replayWaitersRef.current;
      replayWaitersRef.current = [];
      for (const done of waiters) done();
    };

    const abortInFlightCommittedReplay = () => {
      replayGenRef.current += 1;
      if (replayRafRef.current != null) {
        cancelAnimationFrame(replayRafRef.current);
        replayRafRef.current = null;
      }
      committedBuildRef.current = false;
      tileReadyRef.current = () => {};
      // Camera callers are waiting for pixels, not cancellation. Keep their
      // waiters until the idle retry presents, otherwise Board drops the CSS
      // translation while the bitmap still belongs to the previous camera.
    };

    const settleReplayWaitersAfterPaint = (gen: number) => {
      replayRafRef.current = requestAnimationFrame(() => {
        if (gen !== replayGenRef.current) return;
        // This callback is still before browser paint. Resolve on the next
        // frame so the loading check cannot race the canvas present.
        replayRafRef.current = requestAnimationFrame(() => {
          if (gen !== replayGenRef.current) return;
          replayRafRef.current = null;
          settleReplayWaiters();
        });
      });
    };

    const presentCommitted = useCallback(async (liveStamp: InkOp | null = null, instant = true, allowPaused = false): Promise<void> => {
      if (skipCommittedReplay(drawingRef.current, liveStamp)) return Promise.resolve();
      if (splitPausedRef.current && !allowPaused) return;
      // Imperative prime can arrive before the passive attach effect. A
      // missing engine must never acknowledge a successfully painted camera.
      if (!engineRef.current) {
        await new Promise<void>((resolve, reject) => engineWaitersRef.current.push({ resolve, reject }));
      }
      const engine = engineRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !engine) throw new Error("Ink canvas detached before first present");
      if (isLoadingDoodleActive()) await yieldToInput();
      if (engineRef.current !== engine) throw new Error("Ink engine detached before present");
      const { view, paintView, dpr, marginY } = readViews();
      const recordView = () => {
        paintedViewRef.current = {
          scrollX: view.scrollX,
          scrollY: view.scrollY,
          zoom: view.zoom,
          width: view.width,
          height: view.height,
          marginY,
        };
      };
      if (usePreStrokeStamp(liveStamp, pendingStampPatchRef.current != null)) {
        engine.restoreSnapPatch(pendingStampPatchRef.current!);
        engine.paintOntoSnap((sctx) => {
          paintInkStamps(sctx, paintView, [liveStamp!], dpr, clipRef.current, scrollHostLookup());
        });
        engine.paint();
        recordView();
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        replayWaitersRef.current.push(resolve);
        replayGenRef.current += 1;
        const gen = replayGenRef.current;
        replayNeededAfterStrokeRef.current = false;
        if (idleRemeshTimerRef.current != null) {
          window.clearTimeout(idleRemeshTimerRef.current);
          idleRemeshTimerRef.current = null;
        }
        if (replayRafRef.current != null) {
          cancelAnimationFrame(replayRafRef.current);
          replayRafRef.current = null;
        }

        committedBuildRef.current = true;
        replayAllowPausedRef.current = allowPaused;
        const tiles = ensureTiles();
        tiles.setSuspended(splitPausedRef.current && !allowPaused);
        let committed = bookRef.current.paintOps();
        const replayGeometry = new InkGeometrySnapshot();
        replayGeometry.capture(committed);
        tiles.setClip(inkPaintClip(clipRef.current, inkOpsBounds(committed)));
        tiles.syncOpsDeferred(committed);

        /*
         * Camera rebase must land in one present. Slicing across rAFs is how a
         * flick looked like the page reloading — each slice cleared and redrew
         * more spines — and it is only needed when opening a dense book.
         */
        let stepInProgress = false;
        const step = async () => {
          if (gen !== replayGenRef.current) return;
          replayRafRef.current = null;
          stepInProgress = true;
          if (!instant || isLoadingDoodleActive()) await yieldToInput();
          stepInProgress = false;
          if (gen !== replayGenRef.current) return;
          if (drawingRef.current && !finishReplayWhileDrawing()) {
            committedBuildRef.current = false;
            replayNeededAfterStrokeRef.current = true;
            return;
          }
          if (splitPausedRef.current && !allowPaused) return;
          if (sashDragActive()) return;

          const latest = bookRef.current.paintOps();
          if (!replayGeometry.matches(latest)) {
            committed = latest;
            replayGeometry.capture(latest);
            tiles.setClip(inkPaintClip(clipRef.current, inkOpsBounds(latest)));
            tiles.syncOpsDeferred(latest);
          }

          let stage = tileStageRef.current;
          if (!stage) {
            stage = document.createElement("canvas");
            tileStageRef.current = stage;
          }
          if (stage.width !== canvas.width) stage.width = canvas.width;
          if (stage.height !== canvas.height) stage.height = canvas.height;
          const sctx = stage.getContext("2d");
          if (!sctx) {
            committedBuildRef.current = false;
            settleReplayWaiters();
            return;
          }

          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.clearRect(0, 0, stage.width, stage.height);
          const { view: liveView, paintView: livePaint, dpr: liveDpr, marginY: liveMargin } =
            readViews();
          // Never publish tile holes over the last complete camera. With a
          // worker, camera motion only blits; no main-thread stroke remeshing.
          const riding = Boolean(canvas.style.transform);
          tiles.setSliceVisible(!riding && preparingRef.current);
          tiles.draw(sctx, livePaint, liveDpr);
          if (!tiles.covered) return;
          tiles.setSliceVisible(false);
          if (drawingRef.current && !finishReplayWhileDrawing()) {
            committedBuildRef.current = false;
            replayNeededAfterStrokeRef.current = true;
            return;
          }

          capturePageStage(pageStageRef, stage);
          pageGeometryRef.current.capture(committed.filter(op => !isHostBoundOp(op)));
          const hosts = scrollHostLookup();
          hostRasterRef.current.sync(committed);
          sctx.save();
          setInkSceneTransform(sctx, livePaint, liveDpr);
          const clip = clipRef.current;
          if (clip) {
            sctx.beginPath();
            sctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
            sctx.clip();
          }
          hostRasterRef.current.paint(sctx, hosts, livePaint.zoom * liveDpr);
          sctx.restore();
          presentedHostsRef.current = hosts;

          // Keep the old camera visible while tiles are prepared. Replacing
          // the snap, dropping the CSS ride, and painting happen in one tick.
          engine.redrawSnap((snapCtx) => snapCtx.drawImage(stage!, 0, 0));
          if (liveStamp) {
            engine.paintOntoSnap((snapCtx) => {
              paintInkStamps(
                snapCtx,
                livePaint,
                [liveStamp],
                liveDpr,
                clipRef.current,
                scrollHostLookup(),
              );
            });
          }
          if (canvas.style.transform) canvas.style.transform = "";
          engine.paint();
          paintedViewRef.current = {
            scrollX: liveView.scrollX,
            scrollY: liveView.scrollY,
            zoom: liveView.zoom,
            width: liveView.width,
            height: liveView.height,
            marginY: liveMargin,
          };
          committedBuildRef.current = false;
          historyPixelsDirtyRef.current = false;
          replayAllowPausedRef.current = false;
          tiles.setSuspended(splitPausedRef.current);
          // A finished callback must never later overwrite a newly lifted letter.
          overlayRef.current = [];
          overlayRedoRef.current = [];
          tileReadyRef.current = () => {};
          // Instant camera rebase must drop ink CSS and lined-paper ride in
          // this turn (Board's waiter clears paper). Two rAFs at 90Hz is two
          // visible frames of one layer without the other.
          if (instant) settleReplayWaiters();
          else settleReplayWaitersAfterPaint(gen);
        };
        tileReadyRef.current = () => {
          if (gen !== replayGenRef.current || replayRafRef.current != null || stepInProgress) return;
          if (splitPausedRef.current && !allowPaused) return;
          replayRafRef.current = requestAnimationFrame(step);
        };
        if (instant) step();
        else replayRafRef.current = requestAnimationFrame(step);
      });
    }, [ensureTiles, readViews, scrollHostLookup]);

    const scheduleHistoryPaint = (replay: boolean) => {
      historyPixelsDirtyRef.current ||= replay;
      if (historyFrameRef.current != null) return;
      historyFrameRef.current = requestAnimationFrame(() => {
        historyFrameRef.current = null;
        ensureTiles().syncHistoryDeferred(bookRef.current.paintOps());
        if (historyPixelsDirtyRef.current) {
          if (drawingRef.current) { replayNeededAfterStrokeRef.current = true; return; }
          void presentCommitted(null, instantReplayOnUndo());
        }
      });
    };

    const presentHostBoundOnly = useCallback((): boolean => {
      if (drawingRef.current || preparingRef.current) return false;
      if (splitPausedRef.current) return false;
      if (skipHostBoundPresentWhileCameraBusy()) return false;
      if (committedBuildRef.current) return false;
      if (!bookRef.current.hasHostBoundInk()) return false;
      const page = pageStageRef.current;
      const engine = engineRef.current;
      const canvas = canvasRef.current;
      if (!page || !engine || !canvas) return false;
      if (!pageStageMatchesCanvas(page, canvas)) return false;
      const { view, paintView, dpr, marginY } = readViews();
      const next = {
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: view.zoom,
        width: view.width,
        height: view.height,
        marginY,
      };
      if (!samePaintedView(paintedViewRef.current, next)) return false;
      const committed = bookRef.current.paintOps();
      // A page cache from before the latest letter/undo/worker bake is unsafe.
      if (!pageGeometryRef.current.matches(committed.filter(op => !isHostBoundOp(op)))) return false;
      const hosts = scrollHostLookup();
      const oldHosts = presentedHostsRef.current;
      // Layout changes need one complete replay, not a scroll-only patch.
      if (hosts.size !== oldHosts.size) return false;
      for (const [key, h] of hosts) {
        const old = oldHosts.get(key);
        if (!old || old.bounds.minX !== h.bounds.minX || old.bounds.minY !== h.bounds.minY ||
            old.bounds.maxX !== h.bounds.maxX || old.bounds.maxY !== h.bounds.maxY) return false;
      }
      hostRasterRef.current.sync(committed);
      const scale = paintView.zoom * dpr;
      for (const [key, host] of hosts) {
        const old = oldHosts.get(key)!;
        if (old.scrollLeft === host.scrollLeft && old.scrollTop === host.scrollTop) continue;
        // Undo patches contain pixels at the old nested scroll position.
        snapUndoRef.current = [];
        snapRedoRef.current = [];
        pendingStampPatchRef.current = null;
        const b = host.bounds;
        const x = Math.max(0, Math.floor((b.minX + paintView.scrollX) * scale));
        const y = Math.max(0, Math.floor((b.minY + paintView.scrollY) * scale));
        const right = Math.min(canvas.width, Math.ceil((b.maxX + paintView.scrollX) * scale));
        const bottom = Math.min(canvas.height, Math.ceil((b.maxY + paintView.scrollY) * scale));
        if (right <= x || bottom <= y) continue;
        engine.redrawSnapRegion({ x, y, w: right - x, h: bottom - y }, sctx => {
          sctx.drawImage(page, x, y, right - x, bottom - y, x, y, right - x, bottom - y);
          setInkSceneTransform(sctx, paintView, dpr);
          const clip = clipRef.current;
          if (clip) {
            sctx.beginPath();
            sctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
            sctx.clip();
          }
          hostRasterRef.current.paint(sctx, hosts, scale, {
            minX: x / scale - paintView.scrollX, minY: y / scale - paintView.scrollY,
            maxX: right / scale - paintView.scrollX, maxY: bottom / scale - paintView.scrollY,
          });
        });
      }
      presentedHostsRef.current = hosts;
      return true;
    }, [readViews, scrollHostLookup]);

    const forgetPixelHistory = useCallback(() => {
      snapUndoRef.current = [];
      snapRedoRef.current = [];
      pendingStampPatchRef.current = null;
    }, []);

    const rebuildAndReplay = useCallback(
      (keepPixels = false, instant = true, restart = false, allowPaused = false): Promise<void> => {
        if (drawingRef.current) return Promise.resolve();
        if (splitPausedRef.current && !allowPaused) return Promise.resolve();
        // A sliced remesh may join. Camera / undo / a wiped backing store must
        // not — skipping that rebase is ink stuck to the old camera.
        if (!restart && !instant && replayRafRef.current != null) {
          return new Promise((resolve) => {
            replayWaitersRef.current.push(resolve);
          });
        }
        if (!keepPixels) forgetPixelHistory();
        return presentCommitted(null, instant, allowPaused);
      },
      [forgetPixelHistory, presentCommitted],
    );

    const applyPageWindow = useCallback((viewport: ViewportTransform) => {
      const frames = getPageFramesRef.current?.() ?? [];
      const book = bookRef.current;
      const rebin = frames.length > 0 ? book.setFrames(frames) : false;
      if (frames.length === 0) return rebin;
      const top = viewport.scrollY === 0 ? 0 : -viewport.scrollY;
      const zoom = viewport.zoom || 1;
      const bottom = top + viewport.height / zoom;
      const page = pageIdAtViewport(book.frames, top, bottom);
      const windowed = book.setVisiblePage(page);
      const changed = rebin || windowed;
      return changed;
    }, []);

    const presentIfCameraMoved = useCallback((cameraSettle = false, allowPaused = false): Promise<void> => {
      if (drawingRef.current) return Promise.resolve();
      if (splitPausedRef.current && !allowPaused) return Promise.resolve();
      // Riding: a settle remesh must run with the translate still on; finish()
      // drops it in the same present as the new snap. Mid-gesture skips.
      if (!cameraSettle && canvasRef.current?.style.transform) return Promise.resolve();
      // Opening/restore fits can move the camera several times. The loading
      // owner calls primeSnap once layout is final; replaying here would turn
      // each fit into a full dense-page remesh before the spinner can paint.
      if (preparingRef.current) return Promise.resolve();
      const { view, marginY } = readViews();
      const windowed = applyPageWindow(view);
      if (committedBuildRef.current) {
        if (allowPaused && !replayAllowPausedRef.current) {
          return rebuildAndReplay(false, instantReplayOnCameraRebase(), true, true);
        }
        // The active build reads the latest camera before presenting. Joining
        // keeps scroll samples from restarting preparation on every frame.
        return new Promise(resolve => {
          replayWaitersRef.current.push(resolve);
          tileReadyRef.current();
        });
      }
      const next = {
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: view.zoom,
        width: view.width,
        height: view.height,
        marginY,
      };
      if (!paintedViewRef.current) {
        if (windowed || bookRef.current.hasInk()) {
          return rebuildAndReplay(
            false,
            cameraSettle ? instantReplayOnCameraRebase() : instantReplayOnFirstPresent(),
            false, allowPaused,
          );
        }
        return Promise.resolve();
      }
      if (samePaintedView(paintedViewRef.current, next)) {
        if (windowed) {
          return rebuildAndReplay(
            false,
            cameraSettle ? instantReplayOnCameraRebase() : instantReplayOnPageWindow(),
            false, allowPaused,
          );
        }
        return Promise.resolve();
      }
      // Pan and zoom both compose a new frame from cached scene bitmaps. The
      // current camera keeps riding until that complete frame is swapped in.
      return rebuildAndReplay(false, instantReplayOnCameraRebase(), false, allowPaused);
    }, [applyPageWindow, readViews, rebuildAndReplay]);

    useEffect(() => {
      const { view } = readViews();
      if (preparingRef.current) {
        applyPageWindow(view);
        return;
      }
      if (applyPageWindow(view)) rebuildAndReplay(false, instantReplayOnPageWindow());
    }, [applyPageWindow, readViews, rebuildAndReplay]);

    const stampOpOntoSnap = useCallback(
      (op: InkOp) => {
        const engine = engineRef.current;
        if (!engine) return;
        const { paintView, dpr } = readViews();
        engine.paintOntoSnap((sctx) => {
          paintInkStamps(sctx, paintView, [op], dpr, clipRef.current, scrollHostLookup());
        });
      },
      [readViews, scrollHostLookup],
    );

    const rememberCommitPatch = (patch: InkLabSnapPatch | null) => {
      pushCapped(snapUndoRef.current, patch);
      dropRedoStacks(overlayRedoRef.current, snapRedoRef.current);
    };

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          if (!bookRef.current.hasInk()) return;
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          committedBuildRef.current = false;
          tileReadyRef.current = () => {};
          bookRef.current.clear();
          pageStageRef.current = null;
          hostRasterRef.current.sync([]);
          ensureTiles().setOps([]);
          overlayRef.current = [];
          overlayRedoRef.current = [];
          forgetPixelHistory();
          engineRef.current?.clear();
          engineRef.current?.paint();
          settleReplayWaiters();
          onChangeRef.current?.();
        },
        undo() {
          if (drawingRef.current) return false;
          const entry = bookRef.current.undoOnce();
          if (!entry) return false;
          scheduleHistoryPaint(false);
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          committedBuildRef.current = false;
          tileReadyRef.current = () => {};
          const engine = engineRef.current;
          const pixel = snapUndoRef.current.pop();
          // Keep one slot per semantic undo, even past the bitmap cache.
          // Otherwise Redo pairs an old operation with a newer stroke's patch.
          snapRedoRef.current.push(pixel ?? null);
          if (entry.kind === "add" && isInkLabPenOp(entry.op)) {
            undoOverlay(overlayRef.current, overlayRedoRef.current);
          }
          if (pixel && engine && !historyPixelsDirtyRef.current) {
            engine.restoreSnapPatch(pixel);
            engine.paint();
            onChangeRef.current?.();
            return true;
          }
          if (entry.kind === "add" && isInkLabPenOp(entry.op) && engine) {
            scheduleHistoryPaint(true);
            onChangeRef.current?.();
            return true;
          }
          scheduleHistoryPaint(true);
          onChangeRef.current?.();
          return true;
        },
        redo() {
          if (drawingRef.current) return false;
          const entry = bookRef.current.redoOnce();
          if (!entry) return false;
          scheduleHistoryPaint(false);
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          committedBuildRef.current = false;
          tileReadyRef.current = () => {};
          const engine = engineRef.current;
          const pixel = snapRedoRef.current.pop();
          const hadPixel = pixel !== undefined;
          if (hadPixel) pushCapped(snapUndoRef.current, pixel);
          if (entry.kind === "add" && isInkLabPenOp(entry.op)) {
            const spine = redoOverlay(overlayRef.current, overlayRedoRef.current);
            if (spine && engine && !historyPixelsDirtyRef.current) {
              if (!hadPixel) {
                const patch = engine.copySnapPatch();
                if (patch) pushCapped(snapUndoRef.current, patch);
              }
              engine.appendSpines([spine]);
              engine.paint();
              onChangeRef.current?.();
              return true;
            }
          } else if (entry.kind === "add" && engine && !historyPixelsDirtyRef.current) {
            if (!hadPixel) {
              const patch = engine.copySnapPatch();
              if (patch) pushCapped(snapUndoRef.current, patch);
            }
            stampOpOntoSnap(entry.op);
            engine.paint();
            onChangeRef.current?.();
            return true;
          }
          scheduleHistoryPaint(true);
          onChangeRef.current?.();
          return true;
        },
        canUndo() {
          return bookRef.current.canUndo();
        },
        canRedo() {
          return bookRef.current.canRedo();
        },
        hasInk() {
          return bookRef.current.hasInk();
        },
        isDrawing() {
          return drawingRef.current;
        },
        repaint() {
          if (drawingRef.current) return;
          presentIfCameraMoved();
        },
        replayCommitted(onlyHostBound = false) {
          if (drawingRef.current || preparingRef.current) return;
          if (onlyHostBound && !bookRef.current.hasHostBoundInk()) return;
          if (onlyHostBound && presentHostBoundOnly()) return;
          rebuildAndReplay(false, false);
        },
        primeSnap() {
          if (drawingRef.current) return Promise.resolve();
          if (primeSnapRef.current) return primeSnapRef.current;
          sizeToHostRef.current(true, false);
          applyPageWindow(readViews().view);
          // Loading never starts an eager replay, so prime is the single owner
          // of the final laid-out camera and duplicate callers simply join it.
          const pending = rebuildAndReplay(false, instantReplayOnFirstPresent(), true, true)
            .finally(() => {
              if (primeSnapRef.current === pending) primeSnapRef.current = null;
            });
          primeSnapRef.current = pending;
          return pending;
        },
        syncCamera(allowPaused = false) {
          if (drawingRef.current) return Promise.resolve();
          sizeToHostRef.current(allowPaused, false);
          return presentIfCameraMoved(true, allowPaused);
        },
        setPanOffset(live) {
          const canvas = canvasRef.current;
          if (!canvas) return true;
          if (!live) {
            if (canvas.style.transform) canvas.style.transform = "";
            return true;
          }
          // Board already translates `.lc-ink-lab-canvas`. We only veto when
          // the overdraw margin is spent so a rebase can replay at the live camera.
          if (drawingRef.current) return true;
          const painted = paintedViewRef.current;
          if (!painted) return false;
          const marginY = painted.marginY;
          const delta =
            marginY > 0
              ? panDelta(
                  live,
                  painted,
                  { width: painted.width, height: painted.height },
                  PAN_REBASE_FRACTION,
                  { y: marginY * OVERDRAW_REBASE_HEADROOM },
                )
              : panDelta(live, painted, painted);
          return !delta.rebase;
        },
        commitCamera() {
          if (drawingRef.current) return;
          if (canvasRef.current?.style.transform) return;
          presentIfCameraMoved(true);
        },
        setCameraMoving(moving) {
          const wasMoving = cameraMovingRef.current;
          cameraMovingRef.current = moving;
          ensureTiles().setMoving(moving);
          if (moving) {
            const board = boardRoot();
            if (board) invalidateBoardScrollHostLayout(board);
            return;
          }
          // Board owns the pan translate. Clearing it here remeshed at the live
          // camera while the canvas was still riding, which is the ghost, and
          // then land cleared the translate — the rubber-band.
          if (canvasRef.current?.style.transform) return;
          // Tool pick calls this with false. That is not a pan settle.
          if (!remeshOnCameraMovingEnd(wasMoving)) return;
          sizeToHostRef.current();
          presentIfCameraMoved(true);
        },
        cancelCameraMotion() {
          cameraMovingRef.current = false;
        },
        getOps() {
          return bookRef.current.assembleOps();
        },
        setOps(ops, opts) {
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          committedBuildRef.current = false;
          tileReadyRef.current = () => {};
          settleReplayWaiters();
          bookRef.current.replaceAll(cloneOps(ops));
          ensureTiles().syncOpsDeferred(bookRef.current.paintOps());
          if (drawingRef.current) return;
          if (opts?.paint === false) return;
          rebuildAndReplay(false, false);
        },
        getOpCount() {
          return bookRef.current.opCount();
        },
        getRevision() {
          return bookRef.current.revision();
        },
        dirtyInkPageCount() {
          return bookRef.current.dirtyCount();
        },
        takeDirtyInkPages() {
          return bookRef.current.takeDirtyEncoded();
        },
        snapshotInkPages() {
          return bookRef.current.snapshotEncodedPages();
        },
        markInkPagesFlushed(pageIds) {
          bookRef.current.markFlushed(pageIds);
        },
        ingestInkPages(pages, opts) {
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          committedBuildRef.current = false;
          tileReadyRef.current = () => {};
          settleReplayWaiters();
          bookRef.current.ingestEncodedPages(pages);
          ensureTiles().syncOpsDeferred(bookRef.current.paintOps());
          if (drawingRef.current) return;
          if (opts?.paint === false) return;
          rebuildAndReplay(false, false);
        },
        assembleEncoded() {
          return bookRef.current.assembleEncoded();
        },
        encodedShards() {
          return bookRef.current.allEncodedShards();
        },
        inkPageIds() {
          return bookRef.current.pageIds();
        },
        seedColdInkPages(pages) {
          bookRef.current.seedCold(pages);
        },
      }),
      [
        applyPageWindow,
        ensureTiles,
        forgetPixelHistory,
        presentCommitted,
        presentHostBoundOnly,
        presentIfCameraMoved,
        rebuildAndReplay,
        stampOpOntoSnap,
      ],
    );

    useEffect(() => {
      const onDown = (event: KeyboardEvent) => {
        if (event.key !== "Shift" || shiftAnchorRef.current != null) return;
        shiftAnchorRef.current = engineRef.current?.pointCount() ?? 0;
      };
      const onUp = (event: KeyboardEvent) => {
        if (event.key !== "Shift") return;
        shiftAnchorRef.current = null;
      };
      const onBlur = () => {
        shiftAnchorRef.current = null;
      };
      window.addEventListener("keydown", onDown);
      window.addEventListener("keyup", onUp);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("keydown", onDown);
        window.removeEventListener("keyup", onUp);
        window.removeEventListener("blur", onBlur);
      };
    }, []);

    useEffect(() => {
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (!host || !canvas) return;

      const sizeToHost = (allowPaused = false, paint = true) => {
        if (splitPausedRef.current && !allowPaused) return;
        // Frozen while the nib is down or the page is riding: a resize here
        // would remesh the page. Apply it on lift / settle. Overdraw is the
        // pan budget: without it setPanOffset rebases after <1px and every
        // scroll frame remeshes.
        if (drawingRef.current || cameraMovingRef.current || sashDragActive()) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, host.clientWidth);
        const cssH = Math.max(1, host.clientHeight);
        /*
         * Parked panes are `display: none`. Measuring that as 1×1 and remeshing
         * throws the writing away until a later replay — and switching tabs
         * parks the notebook you just left.
         */
        if (host.clientWidth < 8 || host.clientHeight < 8) return;
        const marginY = overdrawMarginPx(cssH, dpr);
        marginYRef.current = marginY;
        const canvasCssH = cssH + 2 * marginY;
        const pixelW = Math.max(1, Math.round(cssW * dpr));
        const pixelH = Math.max(1, Math.round(canvasCssH * dpr));
        const top = `${-marginY}px`;
        if (!inkCanvasCssMatches(canvas, cssW, canvasCssH, top)) {
          canvas.style.width = `${cssW}px`;
          canvas.style.height = `${canvasCssH}px`;
          canvas.style.top = top;
          canvas.style.left = "0px";
        }
        /*
         * `canvas.width = canvas.width` still wipes the bitmap. A CSS `top`
         * mismatch used to count as a resize, clear the page, then remesh
         * every overlay spine on the pointer-up / wheel-open stack — Android
         * ANR on a dense notebook.
         */
        if (!inkCanvasPixelsChanged(canvas, pixelW, pixelH)) return;
        canvas.width = pixelW;
        canvas.height = pixelH;
        paintedViewRef.current = null;
        if (engineRef.current) {
          if (!paint || preparingRef.current || splitPausedRef.current) return;
          rebuildAndReplay(
            false,
            instantReplayOnBackingResize(false),
            true,
          );
        }
      };
      sizeToHostRef.current = sizeToHost;

      sizeToHost(true);
      const engine = createInkLabEngine();
      engineRef.current = engine;
      backendRef.current = engine.attach(canvas);
      for (const waiter of engineWaitersRef.current.splice(0)) waiter.resolve();
      if (!preparingRef.current) {
        rebuildAndReplay(false, instantReplayOnFirstPresent());
      }
      const wantMeter = () => perfOverlayRef.current || perfBarRef.current;
      if (wantMeter()) {
        loadBarRef.current?.show(loadMeterRef.current.peek(), {
          ...INK_LAB_HUD_ZERO,
          backend: backendRef.current,
        });
      }
      let liveDirty = false;
      let liveHold = false;
      let liveTick = 0;
      let lastHudFlushAt = 0;
      const rafGaps: number[] = [];

      const reportLoad = (
        stats: {
          backend: string;
          frameMs: number;
          pts: number;
          segs: number;
          ekfMs: number;
          drawMs: number;
          hold: boolean;
          suffix: boolean;
          dirtyFrom: number;
        },
        rafMs: number,
        live: boolean,
        vsyncMs: number,
      ) => {
        if (!wantMeter()) return;
        const overlayOn = perfOverlayRef.current;
        if (live && overlayOn) {
          hudStatsRef.current.sample(stats.frameMs, rafMs, stats.drawMs, stats.ekfMs);
        }
        const load = live
          ? loadMeterRef.current.frame({
              frameMs: stats.frameMs,
              rafMs,
              spineN: stats.pts,
              dirtyFrom: stats.dirtyFrom,
              suffixHit: stats.suffix,
              queued: 0,
              backend: stats.backend,
              segs: stats.segs,
              ekfMs: stats.ekfMs,
              drawMs: stats.drawMs,
              hold: stats.hold,
            })
          : loadMeterRef.current.peek();
        const bake = bakeRef.current;
        const tiles = peekInkTileMetrics();
        // Sampling remains per paint, while text/spark DOM work is throttled.
        // End-only made the diagnostic overlay useless; per-vsync made it part
        // of the performance problem it was meant to measure.
        const now = performance.now();
        const flushHud = overlayOn && shouldFlushLiveHud(lastHudFlushAt, now, live);
        if (live && !flushHud) return;
        if (flushHud) lastHudFlushAt = now;
        loadBarRef.current?.show(
          load,
          flushHud
            ? {
                backend: load.backend,
                paints: load.calls,
                frameMs: load.frameMs,
                rafMs: load.rafMs,
                pts: load.spineN,
                segs: load.segs,
                ekfMs: load.ekfMs,
                drawMs: load.drawMs,
                hold: load.hold,
                suffix: load.suffixHit,
                bakeMs: bake.bakeMs,
                bake: bake.bake,
                tileMs: tiles.renderMs,
                sdfMs: tiles.sdfMs,
                vsyncMs,
                ...hudStatsRef.current.snapshot(),
              }
            : undefined,
          flushHud,
        );
      };

      const stopPaintPump = () => {
        if (rafRef.current == null) return;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };

      const onPaintFrame = (now: number) => {
        rafRef.current = null;
        if ((splitPausedRef.current || sashDragActive()) && !drawingRef.current) return;
        // Re-arm before paint/HUD. Requesting the next vsync at the end of
        // a long tick is how 16.7ms frames become 33ms (HUD avg ~25ms).
        const live = keepLivePaintPump(drawingRef.current);
        if (live) {
          rafRef.current = requestAnimationFrame(onPaintFrame);
        }
        const prev = lastRafRef.current;
        lastRafRef.current = now;
        const rafMs = prev > 0 ? now - prev : 0;
        if (rafMs > 0) {
          rafGaps.push(rafMs);
          if (rafGaps.length > 8) rafGaps.shift();
        }
        const hz = resolveDisplayHz(displayHzRef.current, medianMs(rafGaps));
        const vsyncMs = vsyncMsForHz(hz);
        loadMeterRef.current.setVsyncMs(vsyncMs);
        const stride = livePresentStride(hz, matchDisplayRef.current);
        const tick = liveTick;
        liveTick += 1;
        if (live && !shouldCompositeLive(liveDirty, liveHold, tick, stride)) {
          if (perfOverlayRef.current && rafMs > 0) hudStatsRef.current.noteRaf(rafMs);
          return;
        }
        const stats = engine.paint();
        liveHold = stats.hold;
        liveDirty = false;
        reportLoad(stats, rafMs, drawingRef.current, vsyncMs);
      };

      const schedulePaint = () => {
        if ((splitPausedRef.current || sashDragActive()) && !drawingRef.current) return;
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(onPaintFrame);
      };

      const armWheel = () => {
        if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          const pending = pendingHoldRef.current;
          if (!pending || pending.opened || pending.decided) return;
          const movedPx = Math.hypot(
            pending.lastX - pending.down.clientX,
            pending.lastY - pending.down.clientY,
          );
          if (
            wheelHoldOutcome(
              movedPx,
              WHEEL_OPEN_MS,
              pending.pathPx,
              pending.moves,
              pending.windRad,
            ) !== "wheel"
          ) {
            pending.decided = true;
            pendingHoldRef.current = null;
            return;
          }
          pending.decided = true;
          pending.opened = true;
          holdNestedScroll();
          drawingRef.current = false;
          lastStrokeAtRef.current = performance.now();
          scheduleIdleRemesh();
          highlightPtsRef.current = null;
          pendingStampPatchRef.current = null;
          erasePtsRef.current = null;
          strokeHostRef.current = null;
          strokeHostElRef.current = null;
          stopPaintPump();
          engine.cancelStroke();
          /*
           * The snap still has the page. sizeToHost + presentCommitted here
           * remeshed every overlay spine on the hold timer — "Whiteboard
           * isn't responding" on a dense Exam page.
           */
          if (skipReplayOnWheelAbort()) {
            engine.paint();
          } else {
            sizeToHost();
            presentCommitted();
          }
          if (wantMeter()) {
            loadMeterRef.current.end();
            loadBarRef.current?.freeze();
          }
          try {
            canvas.releasePointerCapture(pending.pointerId);
          } catch {
            /* ignore */
          }
          onWheelHoldRef.current?.(pending.down.clientX, pending.down.clientY);
        }, WHEEL_OPEN_MS);
      };

      const paintLiveHighlight = () => {
        const pts = highlightPtsRef.current;
        if (!pts || pts.length === 0) return;
        const { paintView } = readViews();
        presentCommitted(
          bindInkOpToHost(
            highlighterDrawOp(
              inkColorRef.current,
              strokeWidthRef.current,
              paintView.zoom,
              liveHighlightPoints(pts, straightInkRef.current),
              highlightTipsRef.current,
            ),
            strokeHostRef.current,
          ),
        );
      };

      const scheduleHighlight = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          paintLiveHighlight();
        });
      };

      let lastEraseSample: { x: number; y: number } | null = null;
      const scheduleErasePaint = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          engine.paint();
        });
      };
      const stampEraser = (event: PointerEvent) => {
        const s = sampleOf(canvas, event);
        const { paintView } = readViews();
        const dpr = canvas.width / Math.max(1, canvas.clientWidth || 1);
        const pageW = eraserPageW();
        const r = eraserCanvasRadius(strokeWidthRef.current, paintView.zoom, dpr, pageW);
        engine.paintOntoSnap((ctx) => {
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fill();
          if (lastEraseSample) {
            ctx.lineWidth = r * 2;
            ctx.lineCap = "round";
            ctx.strokeStyle = "#000";
            ctx.beginPath();
            ctx.moveTo(lastEraseSample.x, lastEraseSample.y);
            ctx.lineTo(s.x, s.y);
            ctx.stroke();
          }
          ctx.restore();
        });
        lastEraseSample = s;
        scheduleErasePaint();
        const live = erasePtsRef.current;
        if (live) {
          appendErasePathPoint(
            live,
            highlightPointOf(canvas, event, paintView),
            eraserSceneRadius(strokeWidthRef.current, pageW),
          );
        }
      };

      let strokePaintView: ViewportTransform | null = null;
      let strokeDpr = 1;
      const cancelIdleRemesh = () => {
        if (idleRemeshTimerRef.current != null) {
          window.clearTimeout(idleRemeshTimerRef.current);
          idleRemeshTimerRef.current = null;
        }
      };
      const scheduleIdleRemesh = () => {
        cancelIdleRemesh();
        if (!replayNeededAfterStrokeRef.current) return;
        idleRemeshTimerRef.current = window.setTimeout(() => {
          idleRemeshTimerRef.current = null;
          if (drawingRef.current) return;
          if (!replayNeededAfterStrokeRef.current) return;
          if (committedBuildRef.current) return;
          replayNeededAfterStrokeRef.current = false;
          void rebuildAndReplay(false, false);
        }, idleRemeshAfterStrokeMs());
      };
      const onPointerDown = (event: PointerEvent) => {
        if (!toolRef.current) return;
        if (onStylusAccessoryRef.current?.(event)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        /*
         * Instant-finishing a sliced remesh under the nib remeshed every
         * overlay spine on the pointer stack — "Whiteboard isn't responding"
         * plus a growing clip square of a half-painted snap.
         * Still start the stroke: abort the in-flight gen so step cannot
         * blit over live pixels, and remesh after the pen has been idle.
         */
        cancelIdleRemesh();
        if (historyPixelsDirtyRef.current) replayNeededAfterStrokeRef.current = true;
        lastStrokeAtRef.current = performance.now();
        if (
          (replayRafRef.current != null || committedBuildRef.current) &&
          !instantReplayOnPointerDown()
        ) {
          abortInFlightCommittedReplay();
          replayNeededAfterStrokeRef.current = true;
        }
        captureStrokeHost(event.clientX, event.clientY);
        const input = readViews();
        strokePaintView = overdrawnViewport(
          inkInputViewport(input.view, paintedViewRef.current, Boolean(canvas.style.transform)),
          input.marginY,
        );
        strokeDpr = input.dpr;
        if (
          wheelHoldEnabledRef.current &&
          toolRef.current &&
          !drawingRef.current
        ) {
          pendingHoldRef.current = {
            pointerId: event.pointerId,
            down: event,
            opened: false,
            decided: false,
            pathPx: 0,
            moves: 0,
            windRad: 0,
            lastStepX: 0,
            lastStepY: 0,
            lastX: event.clientX,
            lastY: event.clientY,
          };
          armWheel();
        }
        drawingRef.current = true;
        holdNestedScroll();
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* untrusted */
        }
        if (toolRef.current === "highlighter") {
          engine.captureSnap();
          pendingStampPatchRef.current = engine.copySnapPatch();
          const { paintView } = readViews();
          highlightPtsRef.current = [highlightPointOf(canvas, event, paintView)];
          paintLiveHighlight();
          return;
        }
        if (toolRef.current !== "pen") {
          engine.captureSnap();
          pendingStampPatchRef.current = engine.copySnapPatch();
          erasePtsRef.current = [];
          lastEraseSample = null;
          stampEraser(event);
          return;
        }
        engine.setPen(
          labPenFromToolbar({
            color: inkColorRef.current,
            uiWidth: strokeWidthRef.current,
            dpr: window.devicePixelRatio || 1,
            pressureClip: pressureClipRef.current,
            pressureSensitive: pressureSensitiveRef.current,
            speed: speedInkRef.current,
            blot: blotRef.current,
            fade: speedFadeRef.current,
            smoothing: smoothingRef.current,
            smoothingMode: smoothingModeRef.current,
            clothoid: clothoidRef.current,
            capillary: capillaryRef.current,
          }),
        );
        // The previous lift/replay already committed the page to the snap.
        // Copying the full overdraw canvas here charges every short pen stroke
        // for pixels that have not changed since the preceding lift.
        engine.down(sampleOf(canvas, event));
        liveDirty = true;
        liveHold = false;
        liveTick = 0;
        rafGaps.length = 0;
        lastRafRef.current = 0;
        if (wantMeter()) {
          loadMeterRef.current.begin();
          hudStatsRef.current.reset();
        }
        schedulePaint();
      };

      const onPointerMove = (event: PointerEvent) => {
        const pending = pendingHoldRef.current;
        if (pending && event.pointerId === pending.pointerId && !pending.opened) {
          pending.pathPx += Math.hypot(event.clientX - pending.lastX, event.clientY - pending.lastY);
          pending.moves += 1;
          pending.windRad += wheelHoldTurn(
            pending.lastStepX,
            pending.lastStepY,
            event.clientX - pending.lastX,
            event.clientY - pending.lastY,
          );
          if (
            wheelHoldIsDrawingHop(
              pending.lastStepX,
              pending.lastStepY,
              event.clientX - pending.lastX,
              event.clientY - pending.lastY,
            )
          ) {
            armWheel();
          }
          pending.lastStepX = event.clientX - pending.lastX;
          pending.lastStepY = event.clientY - pending.lastY;
          pending.lastX = event.clientX;
          pending.lastY = event.clientY;
        }
        if (!drawingRef.current) return;
        if (strokeHostPinRef.current || lastHostScrollRef.current.length > 0) {
          holdNestedScroll();
        }
        if (toolRef.current === "highlighter") {
          const live = highlightPtsRef.current;
          if (!live) return;
          const { paintView } = readViews();
          const coalesced = event.getCoalescedEvents?.();
          const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
          for (const item of batch) live.push(highlightPointOf(canvas, item, paintView));
          scheduleHighlight();
          return;
        }
        if (toolRef.current !== "pen") {
          const coalesced = event.getCoalescedEvents?.();
          const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
          for (const item of batch) stampEraser(item);
          return;
        }
        const coalesced = event.getCoalescedEvents?.();
        const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
        const samples = batch.map((item) => sampleOf(canvas, item));
        const chord = straightAnchorFor(straightInkRef.current, shiftAnchorRef.current);
        const last = samples[samples.length - 1];
        if (chord != null && last) engine.clipLiveToChord(chord, last);
        else engine.move(samples);
        liveDirty = true;
        schedulePaint();
      };

      const onPointerUp = (event: PointerEvent) => {
        const pending = pendingHoldRef.current;
        if (pending && event.pointerId === pending.pointerId) {
          if (holdTimerRef.current != null) {
            window.clearTimeout(holdTimerRef.current);
            holdTimerRef.current = null;
          }
          pendingHoldRef.current = null;
          if (pending.opened) {
            event.preventDefault();
            try {
              canvas.releasePointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            return;
          }
        }
        if (!drawingRef.current) return;
        holdNestedScroll();
        if (toolRef.current === "eraser") stampEraser(event);
        drawingRef.current = false;
        stopPaintPump();
        if (toolRef.current === "eraser") engine.paint();
        lastStrokeAtRef.current = performance.now();
        scheduleIdleRemesh();
        if (toolRef.current === "highlighter") {
          const raw = highlightPtsRef.current;
          highlightPtsRef.current = null;
          if (raw && raw.length > 0) {
            const { paintView } = readViews();
            const shaped = liveHighlightPoints(raw, straightInkRef.current);
            const op = bindInkOpToHost(
              highlighterDrawOp(
                inkColorRef.current,
                strokeWidthRef.current,
                paintView.zoom,
                shaped,
                highlightTipsRef.current,
              ),
              strokeHostRef.current,
            );
            op.points = trimHighlightLiftHook(op.points, highlighterChiselWidth(op.baseWidth));
            if (op.points.length > 0) {
              const committed = bookRef.current.commit(op);
              ensureTiles().deferOp(committed);
              dropRedoStacks(overlayRedoRef.current, snapRedoRef.current);
              const patch = pendingStampPatchRef.current;
              pendingStampPatchRef.current = null;
              if (!patch) {
                rememberCommitPatch(null);
                presentCommitted();
              } else {
                engine.restoreSnapPatch(patch);
                stampOpOntoSnap(op);
                engine.paint();
                rememberCommitPatch(patch);
              }
              onChangeRef.current?.();
            } else {
              pendingStampPatchRef.current = null;
              presentCommitted();
            }
          } else {
            pendingStampPatchRef.current = null;
            presentCommitted();
          }
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            /* ignore */
          }
          strokeHostRef.current = null;
          strokeHostElRef.current = null;
          return;
        }
        if (toolRef.current !== "pen") {
          const raw = erasePtsRef.current;
          erasePtsRef.current = null;
          const patch = pendingStampPatchRef.current;
          pendingStampPatchRef.current = null;
          if (raw && raw.length > 0) {
            const op = bindInkOpToHost(
              {
                kind: "erase" as const,
                radius: eraserSceneRadius(strokeWidthRef.current, eraserPageW()),
                points: raw,
              },
              strokeHostRef.current,
            );
            if (!partialEraseRef.current) {
              const kept = bookRef.current.strokeErase(op);
              if (kept) {
                ensureTiles().syncOpsDeferred(kept);
                rememberCommitPatch(null);
                // The live eraser already changed the authoritative snap.
                // Refresh the camera-independent overlay cache, but do not
                // clear and replay the whole notebook after every rub.
                overlayRef.current = [];
                overlayRedoRef.current = [];
                engine.paint();
                onChangeRef.current?.();
              } else if (patch) {
                engine.restoreSnapPatch(patch);
                engine.paint();
              } else {
                presentCommitted();
              }
            } else {
              const kept = bookRef.current.partialErase(op);
              if (kept) {
                ensureTiles().syncOpsDeferred(kept);
                rememberCommitPatch(null);
                overlayRef.current = [];
                overlayRedoRef.current = [];
                engine.paint();
                onChangeRef.current?.();
              } else if (patch) {
                engine.restoreSnapPatch(patch);
                engine.paint();
              } else {
                presentCommitted();
              }
            }
          } else if (patch) {
            engine.restoreSnapPatch(patch);
            engine.paint();
          }
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            /* ignore */
          }
          strokeHostRef.current = null;
          strokeHostElRef.current = null;
          return;
        }
        const baked = engine.liftRaw(sampleOf(canvas, event));
        bakeRef.current = { bakeMs: baked.bakeMs, bake: baked.bake };
        // Live pixels already sit on the host; lift AABB-patched snap.
        // A full paint() here is another page-sized copy on every letter.
        loadMeterRef.current.end();
        reportLoad(
          {
            backend: backendRef.current,
            frameMs: 0,
            pts: 0,
            segs: 0,
            ekfMs: 0,
            drawMs: 0,
            hold: false,
            suffix: true,
            dirtyFrom: 0,
          },
          0,
          false,
          vsyncMsForHz(resolveDisplayHz(displayHzRef.current, medianMs(rafGaps))),
        );
        loadBarRef.current?.freeze();
        if (baked.points.length > 0) {
          const paintView = strokePaintView ?? readViews().paintView;
          const dpr = strokeDpr;
          const color = inkColorRef.current;
          const uiWidth = strokeWidthRef.current;
          const pressureClip = pressureClipRef.current;
          const pressureSensitive = pressureSensitiveRef.current;
          const speedFade = speedFadeRef.current;
          const strokeHost = strokeHostRef.current;
          const op = bindInkOpToHost(
            opFromBake(
              baked,
              paintView,
              dpr,
              color,
              uiWidth,
              pressureClip,
              pressureSensitive,
              speedFade,
              baked.bakeOptions.smoothing,
            ),
            strokeHost,
          );
          const committed = bookRef.current.commit(op) as InkDrawOp;
          ensureTiles().deferOp(committed);
          if (isInkLabPenOp(op)) {
            const previewSpine = baked.points.map((d) => ({ ...d }));
            commitOverlay(
              overlayRef.current,
              overlayRedoRef.current,
              previewSpine,
            );
            rememberCommitPatch(baked.undoPatch);
            const committedRevision = bookRef.current.revision();
            const committedView = paintedViewRef.current;
            const smoothOnLift = smoothingModeRef.current !== "live" && baked.bakeOptions.smoothing > 0;
            if (smoothOnLift || baked.bakeOptions.clothoid || baked.bakeOptions.capillary) {
              void bakeSpineOffThread(baked.bakeInput, baked.bakeOptions).then((finalBake) => {
                if (engineRef.current !== engine || !canvasRef.current) return;
                const final = { ...baked, ...finalBake, undoPatch: null };
                const finalOp = opFromBake(
                  final,
                  paintView,
                  dpr,
                  color,
                  uiWidth,
                  pressureClip,
                  pressureSensitive,
                  speedFade,
                  baked.bakeOptions.smoothing,
                );
                const previewBounds = inkOpBounds(committed);
                committed.points = finalOp.points;
                const finalBounds = inkOpBounds(committed);
                tilesRef.current?.invalidateBounds(
                  {
                    minX: Math.min(previewBounds.minX, finalBounds.minX),
                    minY: Math.min(previewBounds.minY, finalBounds.minY),
                    maxX: Math.max(previewBounds.maxX, finalBounds.maxX),
                    maxY: Math.max(previewBounds.maxY, finalBounds.maxY),
                  },
                  committed,
                );
                if (bookRef.current.revision() === committedRevision) {
                  bakeRef.current = { bakeMs: finalBake.bakeMs, bake: finalBake.bake };
                }
                // Keep semantic redo in sync with the worker result, including
                // an undo that happened while the worker was running.
                previewSpine.length = 0;
                for (const dot of finalBake.points) previewSpine.push({ ...dot });
                const patch = baked.undoPatch;
                const canReplace = patch && !drawingRef.current &&
                  !historyPixelsDirtyRef.current &&
                  engineRef.current === engine &&
                  paintedViewRef.current === committedView &&
                  bookRef.current.revision() === committedRevision &&
                  snapUndoRef.current[snapUndoRef.current.length - 1] === patch;
                if (canReplace) {
                  snapUndoRef.current[snapUndoRef.current.length - 1] =
                    engine.replaceLastStroke(patch, finalBake.points);
                } else {
                  // Never repaint under a subsequent nib. Old pixel patches
                  // contain pre-bake geometry; semantic history remains valid.
                  historyPixelsDirtyRef.current = true;
                  replayNeededAfterStrokeRef.current = true;
                  scheduleIdleRemesh();
                }
                onChangeRef.current?.();
              }).catch(() => {
                // The already-committed curved preview remains valid ink.
              });
            }
          } else if (!remeshOnHostBoundLift()) {
            rememberCommitPatch(baked.undoPatch);
          } else {
            dropRedoStacks(overlayRedoRef.current, snapRedoRef.current);
            rememberCommitPatch(null);
            presentCommitted(null, true);
          }
          onChangeRef.current?.();
        }
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        strokeHostRef.current = null;
        strokeHostElRef.current = null;
        sizeToHost();
      };

      const ro = new ResizeObserver(() => sizeToHost());
      ro.observe(host);
      // Capture phase of the DOM event (window → canvas, before bubble
      // back out). Not a WebGL stage. Same as RasterInkLayer: ingest
      // before bubble handlers on the board chrome.
      canvas.addEventListener("pointerdown", onPointerDown, true);
      canvas.addEventListener("pointermove", onPointerMove, true);
      canvas.addEventListener("pointerup", onPointerUp, true);
      canvas.addEventListener("pointercancel", onPointerUp, true);
      canvas.addEventListener("lostpointercapture", onPointerUp, true);
      return () => {
        ro.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown, true);
        canvas.removeEventListener("pointermove", onPointerMove, true);
        canvas.removeEventListener("pointerup", onPointerUp, true);
        canvas.removeEventListener("pointercancel", onPointerUp, true);
        canvas.removeEventListener("lostpointercapture", onPointerUp, true);
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        if (historyFrameRef.current != null) cancelAnimationFrame(historyFrameRef.current);
        historyFrameRef.current = null;
        if (replayRafRef.current != null) cancelAnimationFrame(replayRafRef.current);
        replayGenRef.current += 1;
        committedBuildRef.current = false;
        tileReadyRef.current = () => {};
        settleReplayWaiters();
        if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
        if (idleRemeshTimerRef.current != null) {
          window.clearTimeout(idleRemeshTimerRef.current);
          idleRemeshTimerRef.current = null;
        }
        engine.destroy();
        engineRef.current = null;
        for (const waiter of engineWaitersRef.current.splice(0)) {
          waiter.reject(new Error("Ink canvas unmounted before engine attach"));
        }
        tilesRef.current?.dispose();
        tilesRef.current = null;
      };
    }, [
      captureStrokeHost,
      holdNestedScroll,
      presentCommitted,
      readViews,
      rebuildAndReplay,
      stampOpOntoSnap,
    ]);

    useEffect(() => {
      const paused = splitPaused && !preparing;
      tilesRef.current?.setSuspended(paused && !replayAllowPausedRef.current);
      if (paused) {
        if (!drawingRef.current && rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else if (!preparing) {
        sizeToHostRef.current(false, false);
        // Resume a replay left waiting on the paused tile pump as well as a
        // camera that changed while this pane was out of focus.
        if (committedBuildRef.current) void rebuildAndReplay(false, false, true);
        else void presentIfCameraMoved(true);
      }
    }, [splitPaused, preparing, rebuildAndReplay, presentIfCameraMoved]);

    /**
     * Nested scroll moves host-bound ink — remesh when any host scrolls.
     *
     * Scroll does not bubble; capture on the board hears every nested host.
     * Per-host listeners plus MutationObserver/ResizeObserver pick up
     * scrollers that appear after the first scan. Pin by `{ doc, key }` while
     * a drawing tool is armed: React replacing the `<pre>` used to leave the
     * captured node disconnected, so `scrollLeft` snapped to 0 and letters
     * bound against two different offsets.
     */
    useEffect(() => {
      if (!enabled) return;
      const board =
        canvasRef.current?.closest(".lc-board") ?? hostRef.current?.closest(".lc-board");
      if (!board) return;
      let frame: number | null = null;
      let attached: HTMLElement[] = [];
      const onScroll = () => {
        invalidateBoardScrollHostLayout(board);
        if (preparingRef.current || splitPausedRef.current) return;
        if (drawingRef.current || toolRef.current) {
          if (strokeHostPinRef.current || lastHostScrollRef.current.length > 0) {
            holdNestedScroll();
          }
          if (drawingRef.current) return;
        } else {
          lastHostScrollRef.current = snapshotListedHostScroll(nestedHostsRef.current ?? []);
        }
        if (!bookRef.current.hasHostBoundInk()) return;
        if (skipHostBoundPresentWhileCameraBusy()) return;
        if (frame != null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (drawingRef.current || splitPausedRef.current) return;
          // The pending replay reads the latest offsets. Restarting it on
          // every scroll event starves coverage and repeatedly sorts the book.
          if (committedBuildRef.current) return;
          if (toolRef.current) holdNestedScroll();
          if (remeshOnNestedHostScroll() || !presentHostBoundOnly()) {
            forgetPixelHistory();
            presentCommitted(null, false);
          }
        });
      };
      const detachHosts = () => {
        for (const host of attached) {
          host.removeEventListener("scroll", onScroll);
        }
        attached = [];
      };
      const rescanHosts = () => {
        detachHosts();
        fillNestedHosts(board);
        for (const { el } of nestedHostsRef.current ?? []) {
          el.addEventListener("scroll", onScroll, { passive: true });
          attached.push(el);
        }
      };
      rescanHosts();
      if (!toolRef.current) lastHostScrollRef.current = snapshotHostScrollIn(board);
      board.addEventListener("scroll", onScroll, { capture: true, passive: true });
      const mo =
        typeof MutationObserver === "function"
          ? new MutationObserver((records) => {
              if (mutationIsInkChrome(records, hostRef.current)) return;
              if (!mutationAffectsScrollHosts(records)) return;
              rescanHosts();
              if (drawingRef.current) return;
              if (toolRef.current) {
                if (strokeHostPinRef.current || lastHostScrollRef.current.length > 0) {
                  holdNestedScroll();
                }
              } else {
                lastHostScrollRef.current = snapshotHostScrollIn(board);
              }
            })
          : null;
      mo?.observe(board, { childList: true, subtree: true });
      const ro =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              rescanHosts();
              if (!drawingRef.current) onScroll();
            })
          : null;
      for (const doc of board.querySelectorAll(DOC_PAGE_SELECTOR)) {
        ro?.observe(doc);
      }
      return () => {
        board.removeEventListener("scroll", onScroll, true);
        detachHosts();
        mo?.disconnect();
        ro?.disconnect();
        if (frame != null) cancelAnimationFrame(frame);
      };
    }, [enabled, fillNestedHosts, forgetPixelHistory, holdNestedScroll, presentCommitted, presentHostBoundOnly]);

    useEffect(() => {
      if (!enabled) return;
      const board = boardRoot();
      if (!board) return;
      if (!tool) {
        lastHostScrollRef.current = snapshotHostScrollIn(board);
        strokeHostPinRef.current = null;
        return;
      }
      const apply = () => {
        lastHostScrollRef.current = mergeHostScrollSnapshots(
          lastHostScrollRef.current,
          snapshotHostScrollIn(board),
        );
        restoreDroppedHostScroll(board, lastHostScrollRef.current);
      };
      apply();
      const id = requestAnimationFrame(apply);
      return () => cancelAnimationFrame(id);
      // Pen → eraser is not a new nested-scroll world. Snapshot only when
      // a drawing tool arms or the board unmounts the pin.
    }, [boardRoot, enabled, tool == null]);

    useEffect(() => {
      if (!perfOverlay && !perfBar) {
        loadBarRef.current?.hide();
        return;
      }
      loadBarRef.current?.show(loadMeterRef.current.peek(), {
        ...INK_LAB_HUD_ZERO,
        backend: backendRef.current,
        ...hudStatsRef.current.snapshot(),
      });
    }, [perfOverlay, perfBar]);

    /*
     * Always keep the WebGL pad in the tree. `enabled` used to unmount it, and
     * switching to the other split pane / tab sets `interactive` false on this
     * board — which destroyed the engine and looked like the notes had been
     * deleted. Pointers stay off while `tool` is null.
     */
    return (
      <div
        className={tool ? "lc-board-ink-lab-host is-armed" : "lc-board-ink-lab-host"}
        ref={hostRef}
        aria-hidden={!tool}
      >
        <canvas
          ref={canvasRef}
          className={
            tool === "eraser" ? "lc-ink-lab-canvas lc-raster-ink-eraser" : "lc-ink-lab-canvas"
          }
          aria-label="Ink lab pad"
          tabIndex={-1}
          style={{ pointerEvents: tool ? "auto" : "none" }}
        />
        <InkLoadBar ref={loadBarRef} bar={perfBar} overlay={perfOverlay} />
      </div>
    );
  },
);

WhiteboardInkLab.displayName = "WhiteboardInkLab";
