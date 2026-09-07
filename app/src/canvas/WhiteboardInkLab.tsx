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
import { canvasBitmapFromClient } from "./canvasPointer";
import { overlaySpineFromDrawOp, splitInkOpsForLabReplay } from "./inkLab/replay";
import { skipCommittedReplay } from "./inkLab/liveHost";
import {
  createInkLabEngine,
  type InkLabEngine,
  type InkLabSample,
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
  paintRasterInk,
  scenePointFromCanvasPixel,
  trimHighlightLiftHook,
  type InkBlotHalt,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ScenePoint,
  type ViewportTransform,
} from "./rasterInk";
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
  hasInk(): boolean;
  isDrawing(): boolean;
  repaint(): void;
  syncCamera(): void;
  setPanOffset(live: PanCamera | null): boolean;
  commitCamera(): void;
  setCameraMoving(moving: boolean): void;
  getOps(): InkOp[];
  setOps(ops: readonly InkOp[]): void;
  getOpCount(): number;
  getRevision(): number;
  dirtyInkPageCount(): number;
  takeDirtyInkPages(): Map<number, import("./inkCodec").EncodedInk>;
  markInkPagesFlushed(pageIds: Iterable<number>): void;
  ingestInkPages(pages: Map<number, import("./inkCodec").EncodedInk>): void;
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
  onChange?: () => void;
  onStylusAccessory?: (event: PointerEvent) => boolean;
  wheelHoldEnabled?: boolean;
  onWheelHold?: (clientX: number, clientY: number) => void;
  perfOverlay?: boolean;
  perfBar?: boolean;
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

function opFromBake(
  baked: InkLabUpResult,
  view: ViewportTransform,
  dpr: number,
  color: string,
  uiWidth: number,
  pressureClip: number,
  pressureSensitive: boolean,
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
      onChange,
      onStylusAccessory,
      wheelHoldEnabled = false,
      onWheelHold,
      perfOverlay = false,
      perfBar = false,
    }: WhiteboardInkLabProps,
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<InkLabEngine | null>(null);
    const bookRef = useRef(new InkPageBook());
    const overlayRef = useRef<SpineDot[][]>([]);
    const overlayRedoRef = useRef<SpineDot[][]>([]);
    const drawingRef = useRef(false);
    const highlightPtsRef = useRef<ScenePoint[] | null>(null);
    const rafRef = useRef<number | null>(null);
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
    const loadMeterRef = useRef(createInkLoadMeter());
    const loadBarRef = useRef<InkLoadBarHandle>(null);
    const hudStatsRef = useRef(createInkLabHudStats());
    const lastRafRef = useRef(0);
    const bakeRef = useRef({ bakeMs: 0, bake: "catmull" });
    const backendRef = useRef("none");
    const marginYRef = useRef(0);
    const paintedViewRef = useRef<PaintedLabView | null>(null);

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

    const presentCommitted = useCallback((liveStamp: InkOp | null = null) => {
      if (skipCommittedReplay(drawingRef.current, liveStamp)) return;
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
      const { view, paintView, dpr, marginY } = readViews();
      engine.replaySpines(overlayRef.current);
      const { stamp } = splitInkOpsForLabReplay(bookRef.current.paintOps());
      const ops = liveStamp ? [...stamp, liveStamp] : stamp;
      if (ops.length > 0) {
        engine.paintOntoSnap((sctx) => {
          paintRasterInk(sctx, paintView, ops, null, dpr, clipRef.current, false);
        });
      }
      engine.paint();
      paintedViewRef.current = {
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: view.zoom,
        width: view.width,
        height: view.height,
        marginY,
      };
    }, [readViews]);

    const rebuildOverlayFromBook = useCallback(() => {
      const { paintView, dpr } = readViews();
      const { lab } = splitInkOpsForLabReplay(bookRef.current.paintOps());
      overlayRef.current = lab.map((op) => overlaySpineFromDrawOp(op, paintView, dpr));
      overlayRedoRef.current = [];
    }, [readViews]);

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          if (!bookRef.current.hasInk()) return;
          bookRef.current.clear();
          overlayRef.current = [];
          overlayRedoRef.current = [];
          engineRef.current?.clear();
          engineRef.current?.paint();
          onChangeRef.current?.();
        },
        undo() {
          if (drawingRef.current) return false;
          if (!bookRef.current.undoOnce()) return false;
          rebuildOverlayFromBook();
          presentCommitted();
          onChangeRef.current?.();
          return true;
        },
        redo() {
          if (drawingRef.current) return false;
          if (!bookRef.current.redoOnce()) return false;
          rebuildOverlayFromBook();
          presentCommitted();
          onChangeRef.current?.();
          return true;
        },
        canUndo() {
          return bookRef.current.canUndo();
        },
        hasInk() {
          return bookRef.current.hasInk();
        },
        isDrawing() {
          return drawingRef.current;
        },
        repaint() {
          if (drawingRef.current) return;
          if (!toolRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
        },
        syncCamera() {
          if (drawingRef.current) return;
          if (!toolRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
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
          const delta = panDelta(
            live,
            painted,
            { width: painted.width, height: painted.height },
            PAN_REBASE_FRACTION,
            { y: Math.max(1, painted.marginY) * OVERDRAW_REBASE_HEADROOM },
          );
          return !delta.rebase;
        },
        commitCamera() {
          const canvas = canvasRef.current;
          if (canvas?.style.transform) canvas.style.transform = "";
          if (drawingRef.current) return;
          if (!toolRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
        },
        setCameraMoving(moving) {
          if (moving) return;
          const canvas = canvasRef.current;
          if (canvas?.style.transform) canvas.style.transform = "";
          if (drawingRef.current) return;
          if (!toolRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
        },
        getOps() {
          return bookRef.current.assembleOps();
        },
        setOps(ops) {
          bookRef.current.replaceAll(cloneOps(ops));
          if (drawingRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
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
        ingestInkPages(pages) {
          bookRef.current.ingestEncodedPages(pages);
          if (drawingRef.current) return;
          rebuildOverlayFromBook();
          presentCommitted();
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
      [presentCommitted, rebuildOverlayFromBook],
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
      if (!enabled) return;
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (!host || !canvas) return;

      const sizeToHost = () => {
        // Frozen while the nib is down: a resize here would remesh the page
        // and grow the overdraw backing. Apply it on lift.
        if (drawingRef.current) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, host.clientWidth);
        const cssH = Math.max(1, host.clientHeight);
        const marginY = overdrawMarginPx(cssH, dpr);
        marginYRef.current = marginY;
        const canvasCssH = cssH + 2 * marginY;
        const pixelW = Math.max(1, Math.round(cssW * dpr));
        const pixelH = Math.max(1, Math.round(canvasCssH * dpr));
        const top = `${-marginY}px`;
        const resized =
          canvas.width !== pixelW ||
          canvas.height !== pixelH ||
          canvas.style.top !== top;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${canvasCssH}px`;
        canvas.style.top = top;
        canvas.style.left = "0px";
        if (resized) {
          canvas.width = pixelW;
          canvas.height = pixelH;
          if (toolRef.current) {
            rebuildOverlayFromBook();
            presentCommitted();
          }
        }
      };

      sizeToHost();
      const engine = createInkLabEngine();
      engineRef.current = engine;
      backendRef.current = engine.attach(canvas);
      if (toolRef.current) presentCommitted();
      const wantMeter = () => perfOverlayRef.current || perfBarRef.current;
      if (wantMeter()) {
        loadBarRef.current?.show(loadMeterRef.current.peek(), {
          ...INK_LAB_HUD_ZERO,
          backend: backendRef.current,
        });
      }

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
      ) => {
        if (!wantMeter()) return;
        if (live && perfOverlayRef.current) {
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
        const ranges = hudStatsRef.current.snapshot();
        loadBarRef.current?.show(load, {
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
          ...ranges,
        });
      };

      const schedulePaint = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const now = performance.now();
          const prev = lastRafRef.current;
          lastRafRef.current = now;
          const stats = engine.paint();
          reportLoad(stats, prev > 0 ? now - prev : 0, drawingRef.current);
          if (drawingRef.current && stats.hold) schedulePaint();
        });
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
          drawingRef.current = false;
          highlightPtsRef.current = null;
          engine.cancelStroke();
          sizeToHost();
          presentCommitted();
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
          highlighterDrawOp(
            inkColorRef.current,
            strokeWidthRef.current,
            paintView.zoom,
            liveHighlightPoints(pts, straightInkRef.current),
            highlightTipsRef.current,
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
        const dpr = canvas.width / Math.max(1, canvas.clientWidth || 1);
        const r = Math.max(6 * dpr, strokeWidthRef.current * 3 * dpr);
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
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* untrusted */
        }
        if (toolRef.current === "highlighter") {
          const { paintView } = readViews();
          highlightPtsRef.current = [highlightPointOf(canvas, event, paintView)];
          paintLiveHighlight();
          return;
        }
        if (toolRef.current !== "pen") {
          engine.captureSnap();
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
        if (wantMeter()) {
          lastRafRef.current = 0;
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
          stampEraser(event);
          return;
        }
        const coalesced = event.getCoalescedEvents?.();
        const batch = coalesced && coalesced.length > 0 ? coalesced : [event];
        const samples = batch.map((item) => sampleOf(canvas, item));
        const chord = straightAnchorFor(straightInkRef.current, shiftAnchorRef.current);
        const last = samples[samples.length - 1];
        if (chord != null && last) engine.clipLiveToChord(chord, last);
        else engine.move(samples);
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
        drawingRef.current = false;
        if (toolRef.current === "highlighter") {
          const raw = highlightPtsRef.current;
          highlightPtsRef.current = null;
          if (raw && raw.length > 0) {
            const { paintView } = readViews();
            const shaped = liveHighlightPoints(raw, straightInkRef.current);
            const op = highlighterDrawOp(
              inkColorRef.current,
              strokeWidthRef.current,
              paintView.zoom,
              shaped,
              highlightTipsRef.current,
            );
            op.points = trimHighlightLiftHook(op.points, highlighterChiselWidth(op.baseWidth));
            if (op.points.length > 0) {
              bookRef.current.commit(op);
              overlayRedoRef.current = [];
              onChangeRef.current?.();
            }
          }
          presentCommitted();
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            /* ignore */
          }
          return;
        }
        if (toolRef.current !== "pen") {
          engine.captureSnap();
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            /* ignore */
          }
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
        );
        loadBarRef.current?.freeze();
        if (baked.points.length > 0) {
          const { paintView, dpr } = readViews();
          bookRef.current.commit(
            opFromBake(
              baked,
              paintView,
              dpr,
              inkColorRef.current,
              strokeWidthRef.current,
              pressureClipRef.current,
              pressureSensitiveRef.current,
            ),
          );
          overlayRef.current.push(baked.points.map((d) => ({ ...d })));
          overlayRedoRef.current = [];
          onChangeRef.current?.();
        }
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        sizeToHost();
      };

      const ro = new ResizeObserver(() => sizeToHost());
      ro.observe(host);
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      return () => {
        ro.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
        engine.destroy();
        engineRef.current = null;
      };
    }, [enabled, presentCommitted, readViews, rebuildOverlayFromBook]);

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

    useEffect(() => {
      if (!enabled || !tool) return;
      if (drawingRef.current) return;
      rebuildOverlayFromBook();
      presentCommitted();
    }, [enabled, tool, presentCommitted, rebuildOverlayFromBook]);

    if (!enabled) return null;

    return (
      <div
        className={tool ? "lc-board-ink-lab-host is-armed" : "lc-board-ink-lab-host"}
        ref={hostRef}
        aria-hidden={!tool}
      >
        <canvas
          ref={canvasRef}
          className="lc-ink-lab-canvas"
          aria-label="Ink lab pad"
          tabIndex={0}
          style={{ pointerEvents: tool ? "auto" : "none" }}
        />
        <InkLoadBar ref={loadBarRef} bar={perfBar} overlay={perfOverlay} />
      </div>
    );
  },
);

WhiteboardInkLab.displayName = "WhiteboardInkLab";
