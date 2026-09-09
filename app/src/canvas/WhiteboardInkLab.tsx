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
import { wheelHoldIsDrawingHop, wheelHoldOutcome, wheelHoldTurn } from "../util/inkToolPresets";
import { InkPageBook } from "./inkPageCache";
import { pageIdAtViewport, type PageFrame } from "./inkPageIndex";
import { canvasBitmapFromClient } from "./canvasPointer";
import { commitOverlay, dropRedoStacks, pushCapped, redoOverlay, undoOverlay } from "./inkLab/history";
import { isInkLabPenOp, overlaySpineFromDrawOp, splitInkOpsForLabReplay } from "./inkLab/replay";
import { opsWithErasesBaked } from "./strokeEraser";
import {
  inkCanvasPixelsChanged,
  instantReplayOnBackingResize,
  keepLivePaintPump,
  samePaintedView,
  shouldFlushLiveHud,
  skipCommittedReplay,
  skipReplayOnWheelAbort,
  usePreStrokeStamp,
} from "./inkLab/liveHost";
import { REPLAY_SLICE_MS, replayUntil } from "./inkLab/replayJob";
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
import type { SpineDot } from "./inkLab/instance";
import { labPenFromToolbar } from "./inkLab/style";
import { createInkLoadMeter } from "./inkLoadMeter";
import { InkLoadBar, type InkLoadBarHandle } from "./InkLoadBar";
import {
  highlighterChiselWidth,
  highlighterDrawOp,
  inkBaseWidthForZoom,
  isHostBoundOp,
  eraserCanvasRadius,
  eraserSceneRadius,
  paintHostBoundOps,
  paintRasterInk,
  scenePointFromCanvasPixel,
  setInkSceneTransform,
  trimHighlightLiftHook,
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
  hostSceneBounds,
  hostScrollSnapshotOf,
  mergeHostScrollSnapshots,
  pickSettledHostScroll,
  pinHostScrollSnapshot,
  restoreDroppedHostScroll,
  scrollHostAtPoint,
  scrollHostsIn,
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
  replayCommitted(): void;
  syncCamera(): void;
  setPanOffset(live: PanCamera | null): boolean;
  commitCamera(): void;
  setCameraMoving(moving: boolean): void;
  getOps(): InkOp[];
  setOps(ops: readonly InkOp[], opts?: { paint?: boolean }): void;
  getOpCount(): number;
  getRevision(): number;
  dirtyInkPageCount(): number;
  takeDirtyInkPages(): Map<number, import("./inkCodec").EncodedInk>;
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
): InkDrawOp {
  const op: InkDrawOp = {
    kind: "draw",
    color,
    baseWidth: inkBaseWidthForZoom(uiWidth, view.zoom),
    maxFullness: 1,
    pressureClip,
    pressureSensitive,
    points: spineToScene(baked.points, view, dpr),
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
    const lastHostScrollRef = useRef<HostScrollSnapshot[]>([]);
    const highlightPtsRef = useRef<ScenePoint[] | null>(null);
    const erasePtsRef = useRef<ScenePoint[] | null>(null);
    const rafRef = useRef<number | null>(null);
    const replayRafRef = useRef<number | null>(null);
    const replayGenRef = useRef(0);
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
    const sizeToHostRef = useRef<() => void>(() => {});

    const readViews = useCallback(() => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const marginY = marginYRef.current;
      const raw = getViewportRef.current();
      const width = Math.max(1, raw?.width || host?.clientWidth || 1);
      const height = Math.max(1, raw?.height || host?.clientHeight || 1);
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

    const collectScrollHosts = useCallback((): readonly ScrollHostPaintState[] => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const board = canvas.closest(".lc-board");
      if (!board) return [];
      const { paintView } = readViews();
      const rect = canvas.getBoundingClientRect();
      const out: ScrollHostPaintState[] = [];
      for (const doc of board.querySelectorAll(DOC_PAGE_SELECTOR)) {
        for (const [key, el] of scrollHostsIn(doc).entries()) {
          out.push({
            key,
            scrollLeft: el.scrollLeft,
            scrollTop: el.scrollTop,
            bounds: hostSceneBounds(el, rect, paintView),
          });
        }
      }
      return out;
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
      restoreDroppedHostScroll(board, lastHostScrollRef.current);
      const pin = strokeHostPinRef.current;
      if (!pin) return;
      const el = pinHostScrollSnapshot(board, pin);
      if (el) strokeHostElRef.current = el;
    }, [boardRoot]);

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
        const hostEl = scrollHostAtPoint(clientX, clientY);
        if (!hostEl) {
          clear();
          return;
        }
        const live = hostScrollSnapshotOf(hostEl, board);
        if (!live) {
          clear();
          return;
        }
        const remembered = lastHostScrollRef.current.find(
          (s) => s.doc === live.doc && s.key === live.key,
        );
        const pin = pickSettledHostScroll(live, remembered);
        const pinnedEl = pinHostScrollSnapshot(board, pin) ?? hostEl;
        lastHostScrollRef.current = upsertHostScrollSnapshot(lastHostScrollRef.current, pin);
        strokeHostPinRef.current = pin;
        strokeHostElRef.current = pinnedEl;
        const listed = collectScrollHosts().find((host) => host.key === pin.key);
        strokeHostRef.current =
          listed != null
            ? { ...listed, scrollLeft: pin.left, scrollTop: pin.top }
            : ({
                key: pin.key,
                scrollLeft: pin.left,
                scrollTop: pin.top,
                bounds: hostSceneBounds(
                  pinnedEl,
                  canvas.getBoundingClientRect(),
                  readViews().paintView,
                ),
              } satisfies ScrollHostPaintState);
      },
      [boardRoot, collectScrollHosts, readViews],
    );

    const presentCommitted = useCallback((liveStamp: InkOp | null = null, instant = true) => {
      if (skipCommittedReplay(drawingRef.current, liveStamp)) return;
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
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
      const stampTail = (extra: InkOp | null) => {
        const { stamp } = splitInkOpsForLabReplay(
          opsWithErasesBaked(bookRef.current.paintOps()),
        );
        const ops = extra ? [...stamp, extra] : stamp;
        if (ops.length > 0) {
          engine.paintOntoSnap((sctx) => {
            paintInkStamps(sctx, paintView, ops, dpr, clipRef.current, scrollHostLookup());
          });
        }
        engine.paint();
        recordView();
      };

      if (usePreStrokeStamp(liveStamp, pendingStampPatchRef.current != null)) {
        engine.restoreSnapPatch(pendingStampPatchRef.current!);
        engine.paintOntoSnap((sctx) => {
          paintInkStamps(sctx, paintView, [liveStamp!], dpr, clipRef.current, scrollHostLookup());
        });
        engine.paint();
        recordView();
        return;
      }

      replayGenRef.current += 1;
      const gen = replayGenRef.current;
      if (replayRafRef.current != null) {
        cancelAnimationFrame(replayRafRef.current);
        replayRafRef.current = null;
      }

      const strokes = overlayRef.current;
      engine.replaySpines([]);
      if (strokes.length === 0) {
        stampTail(liveStamp);
        return;
      }

      /*
       * Camera rebase must land in one present. Slicing across rAFs is how a
       * flick looked like the page reloading — each slice cleared and redrew
       * more spines — and it is only needed when opening a dense book.
       */
      if (instant) {
        engine.replaySpines(strokes);
        stampTail(liveStamp);
        return;
      }

      let i = 0;
      const step = () => {
        if (gen !== replayGenRef.current) return;
        i = replayUntil(i, strokes.length, () => performance.now(), REPLAY_SLICE_MS, (idx) => {
          engine.appendSpines([strokes[idx]!]);
        });
        engine.paint();
        if (i < strokes.length) {
          replayRafRef.current = requestAnimationFrame(step);
          return;
        }
        replayRafRef.current = null;
        stampTail(liveStamp);
      };
      step();
    }, [readViews, scrollHostLookup]);

    const remeshOverlaysFromBook = useCallback(() => {
      const { paintView, dpr } = readViews();
      const { lab } = splitInkOpsForLabReplay(
        opsWithErasesBaked(bookRef.current.paintOps()),
      );
      overlayRef.current = lab.map((op) => overlaySpineFromDrawOp(op, paintView, dpr));
      const redo: SpineDot[][] = [];
      for (const entry of bookRef.current.redo) {
        if (entry.kind === "add" && isInkLabPenOp(entry.op)) {
          redo.push(overlaySpineFromDrawOp(entry.op, paintView, dpr));
        }
      }
      overlayRedoRef.current = redo;
    }, [readViews]);

    const forgetPixelHistory = useCallback(() => {
      snapUndoRef.current = [];
      snapRedoRef.current = [];
      pendingStampPatchRef.current = null;
    }, []);

    const rebuildAndReplay = useCallback(
      (keepPixels = false, instant = true) => {
        remeshOverlaysFromBook();
        if (!keepPixels) forgetPixelHistory();
        presentCommitted(null, instant);
      },
      [forgetPixelHistory, presentCommitted, remeshOverlaysFromBook],
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
      return rebin || windowed;
    }, []);

    const presentIfCameraMoved = useCallback(() => {
      if (drawingRef.current) return;
      if (canvasRef.current?.style.transform) return;
      const { view, marginY } = readViews();
      if (applyPageWindow(view)) {
        rebuildAndReplay(false, true);
        return;
      }
      if (
        samePaintedView(paintedViewRef.current, {
          scrollX: view.scrollX,
          scrollY: view.scrollY,
          zoom: view.zoom,
          width: view.width,
          height: view.height,
          marginY,
        })
      ) {
        engineRef.current?.paint();
        return;
      }
      rebuildAndReplay(false, true);
    }, [applyPageWindow, readViews, rebuildAndReplay]);

    useEffect(() => {
      const { view } = readViews();
      if (applyPageWindow(view)) rebuildAndReplay(false, true);
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
          bookRef.current.clear();
          overlayRef.current = [];
          overlayRedoRef.current = [];
          forgetPixelHistory();
          engineRef.current?.clear();
          engineRef.current?.paint();
          onChangeRef.current?.();
        },
        undo() {
          if (drawingRef.current) return false;
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          const entry = bookRef.current.undoOnce();
          if (!entry) return false;
          const engine = engineRef.current;
          const pixel = snapUndoRef.current.pop();
          if (pixel !== undefined) snapRedoRef.current.push(pixel);
          if (entry.kind === "add" && isInkLabPenOp(entry.op)) {
            undoOverlay(overlayRef.current, overlayRedoRef.current);
          }
          if (pixel && engine) {
            engine.restoreSnapPatch(pixel);
            engine.paint();
            onChangeRef.current?.();
            return true;
          }
          if (entry.kind === "add" && isInkLabPenOp(entry.op) && engine) {
            presentCommitted(null, true);
            onChangeRef.current?.();
            return true;
          }
          remeshOverlaysFromBook();
          presentCommitted(null, true);
          onChangeRef.current?.();
          return true;
        },
        redo() {
          if (drawingRef.current) return false;
          replayGenRef.current += 1;
          if (replayRafRef.current != null) {
            cancelAnimationFrame(replayRafRef.current);
            replayRafRef.current = null;
          }
          const entry = bookRef.current.redoOnce();
          if (!entry) return false;
          const engine = engineRef.current;
          const pixel = snapRedoRef.current.pop();
          const hadPixel = pixel !== undefined;
          if (hadPixel) pushCapped(snapUndoRef.current, pixel);
          if (entry.kind === "add" && isInkLabPenOp(entry.op)) {
            const spine = redoOverlay(overlayRef.current, overlayRedoRef.current);
            if (spine && engine) {
              if (!hadPixel) {
                const patch = engine.copySnapPatch();
                if (patch) pushCapped(snapUndoRef.current, patch);
              }
              engine.appendSpines([spine]);
              engine.paint();
              onChangeRef.current?.();
              return true;
            }
          } else if (entry.kind === "add" && engine) {
            if (!hadPixel) {
              const patch = engine.copySnapPatch();
              if (patch) pushCapped(snapUndoRef.current, patch);
            }
            stampOpOntoSnap(entry.op);
            engine.paint();
            onChangeRef.current?.();
            return true;
          }
          remeshOverlaysFromBook();
          presentCommitted(null, true);
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
        replayCommitted() {
          if (drawingRef.current) return;
          rebuildAndReplay(false, true);
        },
        syncCamera() {
          if (drawingRef.current) return;
          presentIfCameraMoved();
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
          presentIfCameraMoved();
        },
        setCameraMoving(moving) {
          cameraMovingRef.current = moving;
          if (moving) return;
          // Board owns the pan translate. Clearing it here remeshed at the live
          // camera while the canvas was still riding, which is the ghost, and
          // then land cleared the translate — the rubber-band.
          if (canvasRef.current?.style.transform) return;
          sizeToHostRef.current();
          presentIfCameraMoved();
        },
        getOps() {
          return bookRef.current.assembleOps();
        },
        setOps(ops, opts) {
          bookRef.current.replaceAll(cloneOps(ops));
          if (drawingRef.current) return;
          if (opts?.paint === false) return;
          rebuildAndReplay(false, true);
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
        markInkPagesFlushed(pageIds) {
          bookRef.current.markFlushed(pageIds);
        },
        ingestInkPages(pages, opts) {
          bookRef.current.ingestEncodedPages(pages);
          if (drawingRef.current) return;
          if (opts?.paint === false) return;
          rebuildAndReplay(false, true);
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
        forgetPixelHistory,
        presentCommitted,
        presentIfCameraMoved,
        rebuildAndReplay,
        remeshOverlaysFromBook,
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

      const sizeToHost = () => {
        // Frozen while the nib is down or the page is riding: a resize here
        // would remesh the page. Apply it on lift / settle. Overdraw is the
        // pan budget: without it setPanOffset rebases after <1px and every
        // scroll frame remeshes.
        if (drawingRef.current || cameraMovingRef.current) return;
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
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${canvasCssH}px`;
        canvas.style.top = top;
        canvas.style.left = "0px";
        /*
         * `canvas.width = canvas.width` still wipes the bitmap. A CSS `top`
         * mismatch used to count as a resize, clear the page, then remesh
         * every overlay spine on the pointer-up / wheel-open stack — Android
         * ANR on a dense notebook.
         */
        if (!inkCanvasPixelsChanged(canvas, pixelW, pixelH)) return;
        canvas.width = pixelW;
        canvas.height = pixelH;
        if (engineRef.current) {
          rebuildAndReplay(false, instantReplayOnBackingResize());
        }
      };
      sizeToHostRef.current = sizeToHost;

      sizeToHost();
      const engine = createInkLabEngine();
      engineRef.current = engine;
      backendRef.current = engine.attach(canvas);
      rebuildAndReplay(false, true);
      const wantMeter = () => perfOverlayRef.current || perfBarRef.current;
      if (wantMeter()) {
        loadBarRef.current?.show(loadMeterRef.current.peek(), {
          ...INK_LAB_HUD_ZERO,
          backend: backendRef.current,
        });
      }
      let lastHudFlushAt = 0;
      let liveDirty = false;
      let liveHold = false;
      let liveTick = 0;
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
        const hudNow = typeof performance !== "undefined" ? performance.now() : 0;
        const flushHud = overlayOn && shouldFlushLiveHud(lastHudFlushAt, hudNow, live);
        if (flushHud) lastHudFlushAt = hudNow;
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

      const stampEraser = (event: PointerEvent) => {
        const s = sampleOf(canvas, event);
        const { paintView } = readViews();
        const dpr = canvas.width / Math.max(1, canvas.clientWidth || 1);
        const r = eraserCanvasRadius(strokeWidthRef.current, paintView.zoom, dpr);
        engine.paintOntoSnap((ctx) => {
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
        engine.paint();
        const live = erasePtsRef.current;
        if (live) live.push(highlightPointOf(canvas, event, paintView));
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
         * A sliced remesh from undo still appending spines would capture a
         * half-empty snap, then freeze on the next undo/redo. Finish it
         * before the nib goes down.
         */
        if (replayRafRef.current != null) {
          replayGenRef.current += 1;
          cancelAnimationFrame(replayRafRef.current);
          replayRafRef.current = null;
          presentCommitted(null, true);
        }
        captureStrokeHost(event.clientX, event.clientY);
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
        engine.captureSnap();
        engine.down(sampleOf(canvas, event));
        liveDirty = true;
        liveHold = false;
        liveTick = 0;
        rafGaps.length = 0;
        lastRafRef.current = 0;
        lastHudFlushAt = 0;
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
        holdNestedScroll();
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
        drawingRef.current = false;
        stopPaintPump();
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
              bookRef.current.commit(op);
              dropRedoStacks(overlayRedoRef.current, snapRedoRef.current);
              const patch = pendingStampPatchRef.current;
              pendingStampPatchRef.current = null;
              if (isHostBoundOp(op) || !patch) {
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
                radius: eraserSceneRadius(strokeWidthRef.current),
                points: raw,
              },
              strokeHostRef.current,
            );
            if (!partialEraseRef.current) {
              const kept = bookRef.current.strokeErase(op);
              if (kept) {
                rememberCommitPatch(null);
                rebuildAndReplay(false, true);
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
                rememberCommitPatch(null);
                rebuildAndReplay(false, true);
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
        const baked = engine.up(sampleOf(canvas, event));
        bakeRef.current = { bakeMs: baked.bakeMs, bake: baked.bake };
        engine.paint();
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
          const { paintView, dpr } = readViews();
          const op = bindInkOpToHost(
            opFromBake(
              baked,
              paintView,
              dpr,
              inkColorRef.current,
              strokeWidthRef.current,
              pressureClipRef.current,
              pressureSensitiveRef.current,
              speedFadeRef.current,
            ),
            strokeHostRef.current,
          );
          bookRef.current.commit(op);
          if (isInkLabPenOp(op)) {
            commitOverlay(
              overlayRef.current,
              overlayRedoRef.current,
              baked.points.map((d) => ({ ...d })),
            );
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
        if (replayRafRef.current != null) cancelAnimationFrame(replayRafRef.current);
        replayGenRef.current += 1;
        if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
        engine.destroy();
        engineRef.current = null;
      };
    }, [captureStrokeHost, holdNestedScroll, presentCommitted, readViews, rebuildAndReplay, stampOpOntoSnap]);

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
        if (drawingRef.current || toolRef.current) {
          holdNestedScroll();
          if (drawingRef.current) return;
        } else {
          lastHostScrollRef.current = snapshotHostScrollIn(board);
        }
        if (!bookRef.current.paintOps().some((op) => isHostBoundOp(op))) return;
        if (frame != null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (drawingRef.current) return;
          if (toolRef.current) holdNestedScroll();
          forgetPixelHistory();
          presentCommitted();
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
        for (const doc of board.querySelectorAll(DOC_PAGE_SELECTOR)) {
          for (const host of scrollHostsIn(doc)) {
            host.addEventListener("scroll", onScroll, { passive: true });
            attached.push(host);
          }
        }
      };
      rescanHosts();
      if (!toolRef.current) lastHostScrollRef.current = snapshotHostScrollIn(board);
      board.addEventListener("scroll", onScroll, { capture: true, passive: true });
      const mo =
        typeof MutationObserver === "function"
          ? new MutationObserver(() => {
              rescanHosts();
              if (drawingRef.current || toolRef.current) holdNestedScroll();
              else lastHostScrollRef.current = snapshotHostScrollIn(board);
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
    }, [enabled, forgetPixelHistory, holdNestedScroll, presentCommitted]);

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
    }, [boardRoot, enabled, tool]);

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
