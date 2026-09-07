/**
 * Whiteboard drawing surface. Same loop as {@link ../modes/InkLab.tsx}:
 * attach / down / move / up / paint. Board chrome maps onto the WebGL nib
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
import { overlaySpineFromDrawOp, splitInkOpsForLabReplay } from "./inkLab/replay";
import {
  createInkLabEngine,
  type InkLabEngine,
  type InkLabSample,
  type InkLabUpResult,
} from "./inkLab/engine";
import type { SpineDot } from "./inkLab/instance";
import { labPenFromToolbar } from "./inkLab/style";
import {
  inkBaseWidthForZoom,
  paintRasterInk,
  scenePointFromCanvasPixel,
  type InkBlotHalt,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ScenePoint,
  type ViewportTransform,
} from "./rasterInk";
import type { PanCamera } from "./panOffset";
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
  straightInk?: boolean;
  speedInk?: number;
  speedBlotBlend?: number;
  speedFade?: number;
  getViewport: () => ViewportTransform | null;
  clip?: SceneBounds | null;
  onChange?: () => void;
  onStylusAccessory?: (event: PointerEvent) => boolean;
  wheelHoldEnabled?: boolean;
  onWheelHold?: (clientX: number, clientY: number) => void;
}

function cloneOps(ops: readonly InkOp[]): InkOp[] {
  return ops.map((op) => ({ ...op, points: [...op.points] }));
}

function sampleOf(canvas: HTMLCanvasElement, event: PointerEvent): InkLabSample {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const pressure =
    event.pointerType === "pen" && Number.isFinite(event.pressure)
      ? event.pressure
      : 0.5;
  return {
    x: (event.clientX - rect.left) * dpr,
    y: (event.clientY - rect.top) * dpr,
    p: pressure,
    t: event.timeStamp,
  };
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
      straightInk = false,
      speedInk = 0,
      speedBlotBlend = 0,
      speedFade = 0,
      getViewport,
      clip = null,
      onChange,
      onStylusAccessory,
      wheelHoldEnabled = false,
      onWheelHold,
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
    const speedInkRef = useRef(speedInk);
    speedInkRef.current = speedInk;
    const blotRef = useRef(speedBlotBlend);
    blotRef.current = speedBlotBlend;
    const speedFadeRef = useRef(speedFade);
    speedFadeRef.current = speedFade;
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

    const presentCommitted = useCallback(() => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
      const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
      const view = getViewportRef.current() ?? {
        zoom: 1,
        scrollX: 0,
        scrollY: 0,
        offsetLeft: 0,
        offsetTop: 0,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      engine.replaySpines(overlayRef.current);
      const { stamp } = splitInkOpsForLabReplay(bookRef.current.paintOps());
      if (stamp.length > 0) {
        engine.paintOntoSnap((sctx) => {
          paintRasterInk(sctx, view, stamp, null, dpr, clipRef.current, false);
        });
      }
      engine.paint();
    }, []);

    const rebuildOverlayFromBook = useCallback(() => {
      const canvas = canvasRef.current;
      const dpr = canvas
        ? canvas.width / Math.max(1, canvas.clientWidth || canvas.width)
        : 1;
      const view = getViewportRef.current() ?? {
        zoom: 1,
        scrollX: 0,
        scrollY: 0,
        offsetLeft: 0,
        offsetTop: 0,
        width: canvas?.clientWidth ?? 1,
        height: canvas?.clientHeight ?? 1,
      };
      const { lab } = splitInkOpsForLabReplay(bookRef.current.paintOps());
      overlayRef.current = lab.map((op) => overlaySpineFromDrawOp(op, view, dpr));
      overlayRedoRef.current = [];
    }, []);

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
          if (!bookRef.current.undoOnce()) return false;
          const last = overlayRef.current.pop();
          if (last) overlayRedoRef.current.push(last);
          presentCommitted();
          onChangeRef.current?.();
          return true;
        },
        redo() {
          if (!bookRef.current.redoOnce()) return false;
          const last = overlayRedoRef.current.pop();
          if (last) overlayRef.current.push(last);
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
          presentCommitted();
        },
        syncCamera() {
          engineRef.current?.paint();
        },
        setPanOffset(live) {
          const canvas = canvasRef.current;
          if (!canvas) return true;
          if (!live) {
            if (canvas.style.transform) canvas.style.transform = "";
            return true;
          }
          return true;
        },
        commitCamera() {
          const canvas = canvasRef.current;
          if (canvas?.style.transform) canvas.style.transform = "";
          engineRef.current?.paint();
        },
        setCameraMoving() {},
        getOps() {
          return bookRef.current.assembleOps();
        },
        setOps(ops) {
          bookRef.current.replaceAll(cloneOps(ops));
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
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, host.clientWidth);
        const cssH = Math.max(1, host.clientHeight);
        const pixelW = Math.max(1, Math.round(cssW * dpr));
        const pixelH = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== pixelW || canvas.height !== pixelH) {
          canvas.width = pixelW;
          canvas.height = pixelH;
          canvas.style.width = `${cssW}px`;
          canvas.style.height = `${cssH}px`;
          presentCommitted();
        }
      };

      sizeToHost();
      const engine = createInkLabEngine();
      engineRef.current = engine;
      engine.attach(canvas);
      presentCommitted();

      const schedulePaint = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const stats = engine.paint();
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
          engine.cancelStroke();
          engine.paint();
          try {
            canvas.releasePointerCapture(pending.pointerId);
          } catch {
            /* ignore */
          }
          onWheelHoldRef.current?.(pending.down.clientX, pending.down.clientY);
        }, WHEEL_OPEN_MS);
      };

      const stampAccessory = (event: PointerEvent) => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const s = sampleOf(canvas, event);
        const dpr = canvas.width / Math.max(1, canvas.clientWidth || 1);
        const r = Math.max(6 * dpr, strokeWidthRef.current * 3 * dpr);
        ctx.save();
        if (toolRef.current === "eraser") {
          ctx.globalCompositeOperation = "destination-out";
          ctx.fillStyle = "#000";
        } else {
          ctx.globalCompositeOperation = "multiply";
          ctx.fillStyle = inkColorRef.current;
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
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
        if (toolRef.current !== "pen") {
          engine.captureSnap();
          stampAccessory(event);
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
          }),
        );
        engine.captureSnap();
        engine.down(sampleOf(canvas, event));
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
        if (toolRef.current !== "pen") {
          stampAccessory(event);
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
        engine.paint();
        if (baked.points.length > 0) {
          const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
          const view = getViewportRef.current() ?? {
            zoom: 1,
            scrollX: 0,
            scrollY: 0,
            offsetLeft: 0,
            offsetTop: 0,
            width: canvas.clientWidth,
            height: canvas.clientHeight,
          };
          bookRef.current.commit(
            opFromBake(
              baked,
              view,
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
    }, [enabled, presentCommitted]);

    if (!enabled) return null;

    return (
      <div className="lc-board-ink-lab-host" ref={hostRef}>
        <canvas
          ref={canvasRef}
          className="lc-ink-lab-canvas"
          aria-label="Ink lab pad"
          tabIndex={0}
          style={{ pointerEvents: tool ? "auto" : "none" }}
        />
      </div>
    );
  },
);

WhiteboardInkLab.displayName = "WhiteboardInkLab";
