/**
 * The Excalidraw canvas, wrapped so nothing above it depends on Excalidraw.
 *
 * `@excalidraw/excalidraw` is a plain React component — only excalidraw.com's
 * wrapper is Electron — so it mounts straight into the Tauri WebView.
 *
 * Excalidraw's own chrome is hidden (see `.lc-board` in styles.css) and replaced
 * by {@link BoardToolbar}: pen, eraser, text, shapes, undo, clear, plus font
 * size and board background. A stylus session should never need a menu, and
 * everything that changes what the pen does lives in one strip beside the pen.
 */

import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  SHAPES,
  SHAPE_GROUPS,
  resolveShapeMods,
  DEFAULT_SHAPE_PALETTE,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import {
  loadImportedLibrary,
  parseExcalidrawLibrary,
  placeImportedElements,
  saveImportedLibrary,
  type ImportedLibraryItem,
} from "../templates/libraryImport";
import { regionFrameId, regionFramesOf, syncRegionLayout, type LayoutElement } from "../templates/regionLayout";
import { recolorTemplateElements } from "../templates/problemBoard";
import { codeFrameHeightForSource, codeLabelReserve } from "../util/solutionPad";
import { REGIONS } from "../templates/regions";
import {
  BOARD_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_LABELS,
  FONT_SIZES,
  FONT_UI,
  type Skeleton,
} from "../templates/skeleton";
import { BackgroundPalette } from "../components/BackgroundPalette";
import { ReadingSizeControl } from "../components/ReadingSizeControl";
import { isDarkTheme } from "../theme/appThemes";
import {
  loadBoardReadingSize,
  saveBoardReadingSize,
  type BoardReadingSize,
} from "../modes/codeFontSize";
import { applyBoardReadingSize } from "../modes/applyBoardReadingSize";
import type { BoardHandle, ScreenRect, ToolName } from "./BoardHandle";
import { captureImage, captureStrokes, type SceneElementLike } from "./capture";
import { applyMetadata, keepOnClear, isCoachElement } from "./scene";
import { eraserScreenRadius } from "./rasterInk";
import { EraserBrush } from "./EraserBrush";
import { RasterInkLayer, type RasterInkHandle } from "./RasterInkLayer";
import { StrokeSizeSlider } from "./StrokeSizeSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { STROKE_WIDTH_DEFAULT, type ViewportTransform } from "./rasterInk";

/**
 * The slice of Excalidraw's imperative API this file uses, declared locally so a
 * version bump can't break the build over a type path.
 */
interface ExcalidrawApi {
  getSceneElements(): readonly unknown[];
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  updateScene(scene: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate?:
      | typeof CaptureUpdateAction.NEVER
      | typeof CaptureUpdateAction.IMMEDIATELY
      | typeof CaptureUpdateAction.EVENTUALLY;
  }): void;
  setActiveTool(tool: { type: string; customType?: string }): void;
  setCursor?(cursor: string): void;
  resetCursor?(): void;
  scrollToContent(target?: unknown, opts?: unknown): void;
  onScrollChange?(
    callback: (scrollX: number, scrollY: number, zoom: { value: number }) => void,
  ): () => void;
  history?: { clear(): void };
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.15;
/** Matches Excalidraw's internal wheel-zoom step (not our button ZOOM_STEP). */
const WHEEL_ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** Zoom toward a viewport point so scroll-wheel zoom feels anchored under the cursor. */
function getStateForZoom(
  {
    viewportX,
    viewportY,
    nextZoom,
  }: { viewportX: number; viewportY: number; nextZoom: number },
  appState: {
    offsetLeft?: number;
    offsetTop?: number;
    scrollX?: number;
    scrollY?: number;
    zoom?: { value?: number };
  },
): { scrollX: number; scrollY: number; zoom: { value: number } } {
  const appLayerX = viewportX - (appState.offsetLeft ?? 0);
  const appLayerY = viewportY - (appState.offsetTop ?? 0);
  const currentZoom = appState.zoom?.value ?? 1;
  const baseScrollX = (appState.scrollX ?? 0) + (appLayerX - appLayerX / currentZoom);
  const baseScrollY = (appState.scrollY ?? 0) + (appLayerY - appLayerY / currentZoom);
  return {
    scrollX: baseScrollX - (appLayerX - appLayerX / nextZoom),
    scrollY: baseScrollY - (appLayerY - appLayerY / nextZoom),
    zoom: { value: nextZoom },
  };
}

/** Hide the OS cursor on the canvas — {@link EraserBrush} draws the ring. */
function eraserCanvasCursorCss(): string {
  return "none";
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Excalidraw only handles undo/redo when its key handler runs — not via a fake API. */
function triggerUndo(): void {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }),
  );
}

function triggerRedo(): void {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }),
  );
}

export interface BoardProps {
  /** Called whenever the scene changes, so the ambient loop can sample it. */
  onChange?: () => void;
  themeId: string;
  onThemePick?: (id: string) => void;
  /** False on the problem browser — canvas is read-only and tools are hidden. */
  interactive?: boolean;
  /** Screen rect of the solution-code region, updated as you pan/zoom/resize. */
  onCodeSlot?: (rect: ScreenRect | null) => void;
  /** Shared S/M/L size for problem statement + code. */
  readingSize?: BoardReadingSize;
  onReadingSizeChange?: (size: BoardReadingSize) => void;
}

const INK_COLORS_LIGHT = ["#1e1e1e", "#64748b", "#b45309", "#1d4ed8", "#166534", "#b91c1c"] as const;
const INK_COLORS_DARK = ["#f3f4f6", "#94a3b8", "#fb923c", "#60a5fa", "#4ade80", "#f87171"] as const;

function defaultInk(themeId: string): string {
  return isDarkTheme(themeId) ? INK_COLORS_DARK[0] : INK_COLORS_LIGHT[0];
}

function inkSwatches(themeId: string): readonly string[] {
  return isDarkTheme(themeId) ? INK_COLORS_DARK : INK_COLORS_LIGHT;
}

const TOOLS: Array<{ tool: ToolName; label: string; hint: string; emoji?: string }> = [
  { tool: "hand", label: "hand", hint: "Pan — drag to move; scroll wheel zooms", emoji: "✋" },
  { tool: "selection", label: "⬚", hint: "Select — resize region boxes or move your work" },
  { tool: "freedraw", label: "Pen", hint: "Pen", emoji: "✏️" },
  { tool: "eraser", label: "Eraser", hint: "Eraser — only removes ink under the brush", emoji: "erasersvg" },
  { tool: "text", label: "T", hint: "Text" },
  { tool: "rectangle", label: "▭", hint: "Rectangle" },
  { tool: "ellipse", label: "◯", hint: "Ellipse" },
  { tool: "arrow", label: "↗", hint: "Arrow" },
];

/** Stable across renders — a fresh object makes Excalidraw thrash its tunnel store. */
const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: false,
  },
  tools: { image: false },
} as const;

function roundPx(value: number): number {
  return Math.round(value);
}

function sameCodeSlot(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.zoom === b.zoom
  );
}

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(
  {
    onChange,
    themeId,
    onThemePick,
    interactive = true,
    onCodeSlot,
    readingSize: readingSizeProp,
    onReadingSizeChange,
  },
  ref,
) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("hand");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const [inkColor, setInkColor] = useState(() => defaultInk(themeId));
  const [strokeWidth, setStrokeWidthState] = useState(STROKE_WIDTH_DEFAULT);
  const [pressureSensitive, setPressureSensitive] = useState(true);
  const [eraserBrush, setEraserBrush] = useState({ visible: false, x: 0, y: 0, zoom: 1 });
  const rasterInkRef = useRef<RasterInkHandle>(null);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [readingSizeLocal, setReadingSizeLocal] = useState<BoardReadingSize>(() => loadBoardReadingSize());
  const readingSize = readingSizeProp ?? readingSizeLocal;
  const readingSizeRef = useRef(readingSize);
  readingSizeRef.current = readingSize;
  const templateRef = useRef<unknown[]>([]);
  const seedSkeletonsRef = useRef<Skeleton[]>([]);
  const scrollUnsubRef = useRef<(() => void) | null>(null);
  const layoutSyncingRef = useRef(false);
  const codeContentHeightRef = useRef<number | null>(null);
  const lastCodeSourceRef = useRef<string>("");
  const lastCodeSlotRef = useRef<ScreenRect | null>(null);
  const onCodeSlotRef = useRef(onCodeSlot);
  onCodeSlotRef.current = onCodeSlot;

  // Library stamps must stay draggable — older imports may still be locked.
  useEffect(() => {
    if (!interactive) return;
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElements() as Array<{
      locked?: boolean;
      customData?: { lcStamp?: boolean } | null;
      [key: string]: unknown;
    }>;
    let changed = false;
    const next = current.map((element) => {
      if (element.customData?.lcStamp && element.locked) {
        changed = true;
        return { ...element, locked: false };
      }
      return element;
    });
    if (!changed) return;
    api.updateScene({
      elements: next,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [interactive]);

  const elements = useCallback((): SceneElementLike[] => {
    return (apiRef.current?.getSceneElements() ?? []) as SceneElementLike[];
  }, []);

  const reportCodeSlot = useCallback(() => {
    const api = apiRef.current;
    const notify = onCodeSlotRef.current;
    if (!api || !notify) return;

    const frame = (api.getSceneElements() as LayoutElement[]).find(
      (element) =>
        element.type === "rectangle" &&
        (element.id === regionFrameId("code") ||
          (element.customData?.lcRegion === "code" && element.customData?.lcRegionFrame)),
    );
    if (!frame) {
      if (lastCodeSlotRef.current !== null) {
        lastCodeSlotRef.current = null;
        notify(null);
      }
      return;
    }

    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
      width?: number;
      height?: number;
    };
    const zoom = state.zoom?.value ?? 1;
    const scrollX = state.scrollX ?? 0;
    const scrollY = state.scrollY ?? 0;
    // Overlay is positioned inside `.lc-canvas-wrap`, which matches the Excalidraw
    // viewport — do not add page offsets (those are for clientX/clientY only).
    const inset = Math.max(6, Math.round(8 * zoom));
    // Leave room for the CODE label + hint above Monaco (same chrome as Approach).
    const headerReserve = Math.round(codeLabelReserve(readingSizeRef.current) * zoom);
    const next: ScreenRect = {
      left: roundPx((frame.x + scrollX) * zoom + inset),
      top: roundPx((frame.y + scrollY) * zoom + inset + headerReserve),
      width: roundPx(Math.max(0, num(frame.width, REGIONS.code.w) * zoom - inset * 2)),
      height: roundPx(
        Math.max(0, num(frame.height, REGIONS.code.h) * zoom - inset * 2 - headerReserve),
      ),
      zoom: Math.round(zoom * 1000) / 1000,
    };

    // Hide the dock when the code frame is fully off-screen — switching to the
    // fallback absolute slot caused a visible snap while panning past the box.
    const viewH = typeof state.height === "number" ? state.height : 0;
    const viewW = typeof state.width === "number" ? state.width : 0;
    const offscreen =
      next.top + next.height < -40 ||
      next.top > viewH + 40 ||
      next.left + next.width < -40 ||
      next.left > viewW + 40 ||
      next.width < 24 ||
      next.height < 24;
    if (offscreen) {
      if (lastCodeSlotRef.current !== null) {
        lastCodeSlotRef.current = null;
        notify(null);
      }
      return;
    }

    // New object every frame would re-render App → resize Excalidraw → onChange
    // → report again ("Maximum update depth exceeded").
    if (sameCodeSlot(lastCodeSlotRef.current, next)) return;
    lastCodeSlotRef.current = next;
    notify(next);
  }, []);

  const setStrokeWidth = useCallback((width: number) => {
    setStrokeWidthState(width);
    apiRef.current?.updateScene({ appState: { currentItemStrokeWidth: width } });
    if (activeTool === "eraser") {
      apiRef.current?.setCursor?.(eraserCanvasCursorCss());
    }
  }, [activeTool]);

  const setTool = useCallback((tool: ToolName) => {
    if (tool === "freedraw") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcInk" });
      apiRef.current?.resetCursor?.();
      setEraserBrush({ visible: false, x: 0, y: 0, zoom: 1 });
    } else if (tool === "eraser") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcEraser" });
      apiRef.current?.setCursor?.(eraserCanvasCursorCss());
    } else {
      apiRef.current?.setActiveTool({ type: tool });
      apiRef.current?.resetCursor?.();
      setEraserBrush({ visible: false, x: 0, y: 0, zoom: 1 });
    }
    setActiveTool(tool);
  }, []);

  /** Scene coords from a pointer event over the Excalidraw viewport. */
  const clientToScene = useCallback((clientX: number, clientY: number) => {
    const state = apiRef.current?.getAppState() as
      | {
          zoom?: { value?: number };
          scrollX?: number;
          scrollY?: number;
          offsetLeft?: number;
          offsetTop?: number;
        }
      | undefined;
    const zoom = state?.zoom?.value ?? 1;
    return {
      x: (clientX - (state?.offsetLeft ?? 0)) / zoom - (state?.scrollX ?? 0),
      y: (clientY - (state?.offsetTop ?? 0)) / zoom - (state?.scrollY ?? 0),
      zoom,
    };
  }, []);

  const getViewport = useCallback((): ViewportTransform | null => {
    const state = apiRef.current?.getAppState() as
      | {
          zoom?: { value?: number };
          scrollX?: number;
          scrollY?: number;
          offsetLeft?: number;
          offsetTop?: number;
          width?: number;
          height?: number;
        }
      | undefined;
    if (!state || typeof state.width !== "number" || typeof state.height !== "number") {
      return null;
    }
    return {
      zoom: state.zoom?.value ?? 1,
      scrollX: state.scrollX ?? 0,
      scrollY: state.scrollY ?? 0,
      offsetLeft: state.offsetLeft ?? 0,
      offsetTop: state.offsetTop ?? 0,
      width: state.width,
      height: state.height,
    };
  }, []);

  const inkToolActive = activeTool === "freedraw" || activeTool === "eraser";

  // Eraser ring follows the pointer via window listeners so a click-without-move
  // does not lose the brush (pointerleave on the board fired sporadically).
  useEffect(() => {
    if (!interactive || activeTool !== "eraser") return;
    const root = boardRef.current;
    if (!root) return;

    const positionBrush = (event: PointerEvent) => {
      const hitCanvas =
        root.querySelector("canvas.lc-raster-ink") ??
        root.querySelector("canvas.excalidraw__canvas");
      if (!(hitCanvas instanceof HTMLCanvasElement)) return;
      const rect = hitCanvas.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) {
        setEraserBrush((brush) => (brush.visible ? { ...brush, visible: false } : brush));
        return;
      }
      const boardRect = root.getBoundingClientRect();
      const { zoom } = clientToScene(event.clientX, event.clientY);
      setEraserBrush({
        visible: true,
        x: event.clientX - boardRect.left,
        y: event.clientY - boardRect.top,
        zoom,
      });
    };

    window.addEventListener("pointermove", positionBrush);
    window.addEventListener("pointerdown", positionBrush, true);
    apiRef.current?.setCursor?.(eraserCanvasCursorCss());

    return () => {
      window.removeEventListener("pointermove", positionBrush);
      window.removeEventListener("pointerdown", positionBrush, true);
      setEraserBrush({ visible: false, x: 0, y: 0, zoom: 1 });
    };
  }, [activeTool, clientToScene, interactive]);

  const undoBoard = useCallback(() => {
    if (rasterInkRef.current?.undo()) return;
    triggerUndo();
  }, []);

  const redoBoard = useCallback(() => {
    if (rasterInkRef.current?.redo()) return;
    triggerRedo();
  }, []);

  /**
   * Turn skeletons into elements, then stamp the metadata back on — bound
   * labels get generated ids and would otherwise lose their region/viz tag.
   *
   * Template seeds pass `regenerateIds: false` so `lcregion-*` ids survive and
   * Appearance can recolor statement text. Stamps keep the default (new ids).
   */
  const convert = useCallback(
    (skeletons: Skeleton[], opts?: { regenerateIds?: boolean }): unknown[] => {
      const converted = convertToExcalidrawElements(skeletons as never, {
        regenerateIds: opts?.regenerateIds ?? true,
      }) as unknown[];
      return applyMetadata(converted as never, skeletons);
    },
    [],
  );

  const setFontSize = useCallback((size: number) => {
    setFontSizeState(size);
    apiRef.current?.updateScene({ appState: { currentItemFontSize: size } });
  }, []);

  const setInk = useCallback((color: string) => {
    setInkColor(color);
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } });
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
    const ink = defaultInk(themeId);
    setInkColor(ink);
    if (!api) return;

    const dark = isDarkTheme(themeId);
    const elements = api.getSceneElements() as SceneElementLike[];
    const recolored = recolorTemplateElements(elements, dark);

    api.updateScene({
      appState: {
        viewBackgroundColor: theme.background,
        currentItemStrokeColor: ink,
      },
      ...(recolored
        ? { elements: recolored as unknown[], captureUpdate: CaptureUpdateAction.NEVER }
        : {}),
    });
  }, [themeId]);

  const readZoom = useCallback(() => {
    const state = apiRef.current?.getAppState() as { zoom?: { value?: number } } | undefined;
    return state?.zoom?.value ?? 1;
  }, []);

  const setZoom = useCallback(
    (next: number) => {
      const clamped = clampZoom(next);
      apiRef.current?.updateScene({ appState: { zoom: { value: clamped } } });
      setZoomPct(Math.round(clamped * 100));
      requestAnimationFrame(reportCodeSlot);
    },
    [reportCodeSlot],
  );

  const zoomIn = useCallback(() => setZoom(readZoom() * ZOOM_STEP), [readZoom, setZoom]);
  const zoomOut = useCallback(() => setZoom(readZoom() / ZOOM_STEP), [readZoom, setZoom]);

  // Excalidraw pans on wheel by default (Ctrl/Cmd+wheel zooms). Prefer scroll =
  // zoom toward the cursor; hand-tool drag stays the way to pan. Shift+wheel
  // still pans as an escape hatch. Leave Monaco / chrome alone.
  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".lc-code-dock, .lc-toolbar, .lc-map-controls, .monaco-editor, textarea, input, [contenteditable='true']",
        )
      ) {
        return;
      }
      if (!target.closest(".excalidraw")) return;

      const api = apiRef.current;
      if (!api) return;

      const state = api.getAppState() as {
        zoom?: { value?: number };
        scrollX?: number;
        scrollY?: number;
        offsetLeft?: number;
        offsetTop?: number;
      };
      const zoom = state.zoom?.value ?? 1;

      // Shift+wheel: pan (trackpad / mouse escape without switching tools).
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        api.updateScene({
          appState: {
            scrollX: (state.scrollX ?? 0) - (event.deltaY || event.deltaX) / zoom,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(reportCodeSlot);
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const { deltaY } = event;
      const sign = Math.sign(deltaY) || -1;
      const maxStep = WHEEL_ZOOM_STEP * 100;
      const absDelta = Math.abs(deltaY);
      let delta = deltaY;
      if (absDelta > maxStep) {
        delta = maxStep * sign;
      }
      let next = zoom - delta / 100;
      next +=
        Math.log10(Math.max(1, zoom)) * -sign * Math.min(1, absDelta / 20);
      const nextZoom = clampZoom(next);
      if (nextZoom === zoom) return;

      api.updateScene({
        appState: getStateForZoom(
          {
            viewportX: event.clientX,
            viewportY: event.clientY,
            nextZoom,
          },
          state,
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setZoomPct(Math.round(nextZoom * 100));
      requestAnimationFrame(reportCodeSlot);
    };

    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [interactive, reportCodeSlot]);

  const fitView = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;

    const live = api.getSceneElements() as LayoutElement[];
    const frames = regionFramesOf(live);
    // Land on the problem statement + code only — never the full board
    // (Approach / Walkthrough / Coach), which zooms out to a tiny corner.
    const focusFrames = (["constraints", "code"] as const)
      .map((id) => frames.get(id))
      .filter((frame): frame is LayoutElement => Boolean(frame));

    const tagged =
      focusFrames.length > 0
        ? focusFrames
        : live.filter((element) => {
            const region = element.customData?.lcRegion;
            return region === "constraints" || region === "code";
          });

    const template = templateRef.current as LayoutElement[];
    const target =
      tagged.length > 0
        ? tagged
        : template.length > 0
          ? template.filter((element) => {
              const region = element.customData?.lcRegion;
              return region === "constraints" || region === "code";
            })
          : live;

    const focus = target.length > 0 ? target : live;

    // Leave room for the floating toolbar; bottom inset is larger so fit prefers
    // the upper viewport instead of vertically centering the stack.
    api.scrollToContent(focus, {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: false,
      canvasOffsets: { top: 28, left: 72, right: 28, bottom: 120 },
    });

    // scrollToContent still centers within the inset — pin the focus block near
    // the top-left so load matches the composed problem layout.
    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
    };
    const zoom = state.zoom?.value ?? 1;
    let minX = Infinity;
    let minY = Infinity;
    for (const element of focus) {
      if (typeof element.x === "number") minX = Math.min(minX, element.x);
      if (typeof element.y === "number") minY = Math.min(minY, element.y);
    }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      const topMargin = 36;
      const leftMargin = 88;
      // scene → screen: (scene + scroll) * zoom  (see Board.stamp)
      api.updateScene({
        appState: {
          scrollX: leftMargin / zoom - minX,
          scrollY: topMargin / zoom - minY,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    setZoomPct(Math.round(readZoom() * 100));
    requestAnimationFrame(reportCodeSlot);
  }, [readZoom, reportCodeSlot]);

  /** Run fit after Excalidraw has applied scene + container size. */
  const scheduleFitView = useCallback(() => {
    const run = () => fitView();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        run();
        window.setTimeout(run, 60);
        window.setTimeout(run, 200);
      });
    });
  }, [fitView]);

  const settleFitView = useCallback((): Promise<void> => {
    const waitFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });
    return (async () => {
      await waitFrame();
      await waitFrame();
      fitView();
      await wait(50);
      fitView();
      await wait(120);
      fitView();
      await waitFrame();
    })();
  }, [fitView]);

  /** Drop a configured stamp near the middle of what's currently on screen. */
  const stamp = useCallback(
    (shape: ShapeStamp, mods: Record<string, ShapeModValue>, moveAsOne: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
        zoom?: { value?: number };
      };
      const zoom = state.zoom?.value ?? 1;
      const x = Math.round(-(state.scrollX ?? 0) + (state.width ?? 1200) / (2 * zoom) - 200);
      const y = Math.round(-(state.scrollY ?? 0) + (state.height ?? 800) / (2 * zoom) - 100);
      const resolved = resolveShapeMods(shape, mods);
      // Fixed sketch palette — stamps do not follow Appearance.
      let pieces = convert(shape.build(x, y, resolved, DEFAULT_SHAPE_PALETTE)) as Array<{
        id: string;
        groupIds?: string[];
        customData?: Record<string, unknown> | null;
        [key: string]: unknown;
      }>;

      if (moveAsOne && pieces.length > 1) {
        const groupId = `lcstamp-${shape.id}-${Date.now().toString(36)}`;
        pieces = pieces.map((element) => ({
          ...element,
          locked: false,
          groupIds: [...(element.groupIds ?? []), groupId],
          customData: {
            ...(element.customData ?? {}),
            lcStamp: true,
            lcStampGroup: groupId,
          },
        }));
      } else {
        pieces = pieces.map((element) => ({
          ...element,
          locked: false,
          customData: {
            ...(element.customData ?? {}),
            lcStamp: true,
          },
        }));
      }

      // IMMEDIATELY so Undo/Redo include library stamps (Server, Array, …).
      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...pieces],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setShapesOpen(false);
      setTool("selection");
    },
    [convert, setTool],
  );

  const stampImported = useCallback(
    (item: ImportedLibraryItem, moveAsOne: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
        zoom?: { value?: number };
      };
      const zoom = state.zoom?.value ?? 1;
      const x = Math.round(-(state.scrollX ?? 0) + (state.width ?? 1200) / (2 * zoom) - 200);
      const y = Math.round(-(state.scrollY ?? 0) + (state.height ?? 800) / (2 * zoom) - 100);
      const pieces = placeImportedElements(item.elements, x, y, moveAsOne);
      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...pieces],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setShapesOpen(false);
      setTool("selection");
    },
    [setTool],
  );

  // Excalidraw can reset the active tool during its own mount; re-assert the
  // default once the API is live so a session starts in pan mode, not drawing.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (apiRef.current && activeTool === "hand") {
        apiRef.current.setActiveTool({ type: "hand" });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [activeTool]);

  const resetTemplate = useCallback(() => {
    const skeletons = seedSkeletonsRef.current;
    if (skeletons.length === 0) return;
    const dark = isDarkTheme(themeId);
    const converted = convert(skeletons, { regenerateIds: false }) as SceneElementLike[];
    const recolored = recolorTemplateElements(converted, dark) ?? converted;
    const sized = applyBoardReadingSize(recolored, readingSizeRef.current, { captureFrom: "M" });
    templateRef.current = sized;
    apiRef.current?.updateScene({
      elements: sized as unknown[],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    requestAnimationFrame(() => {
      scheduleFitView();
    });
  }, [convert, scheduleFitView, themeId]);

  const applyRegionLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api || layoutSyncingRef.current) return;
    const synced = syncRegionLayout(api.getSceneElements() as LayoutElement[], {
      codeContentHeight: codeContentHeightRef.current ?? undefined,
    });
    if (!synced) return;
    layoutSyncingRef.current = true;
    api.updateScene({
      elements: synced,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    requestAnimationFrame(() => {
      layoutSyncingRef.current = false;
    });
  }, []);

  const fitCodeToSource = useCallback(
    (source: string) => {
      lastCodeSourceRef.current = source;
      codeContentHeightRef.current = codeFrameHeightForSource(source, readingSizeRef.current);
      applyRegionLayout();
      requestAnimationFrame(reportCodeSlot);
    },
    [applyRegionLayout, reportCodeSlot],
  );

  const setReadingSize = useCallback(
    (next: BoardReadingSize) => {
      const prev = readingSizeRef.current;
      if (next === prev) {
        onReadingSizeChange?.(next);
        return;
      }
      readingSizeRef.current = next;
      setReadingSizeLocal(next);
      saveBoardReadingSize(next);
      onReadingSizeChange?.(next);

      const api = apiRef.current;
      if (!api) return;

      const scaled = applyBoardReadingSize(api.getSceneElements() as SceneElementLike[], next, {
        captureFrom: prev,
      });
      layoutSyncingRef.current = true;
      api.updateScene({
        elements: scaled as unknown[],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      requestAnimationFrame(() => {
        layoutSyncingRef.current = false;
        if (lastCodeSourceRef.current) {
          codeContentHeightRef.current = codeFrameHeightForSource(
            lastCodeSourceRef.current,
            next,
          );
        }
        applyRegionLayout();
        reportCodeSlot();
      });
    },
    [applyRegionLayout, onReadingSizeChange, reportCodeSlot],
  );

  const handleSceneChange = useCallback(() => {
    applyRegionLayout();
    reportCodeSlot();
    onChange?.();
  }, [applyRegionLayout, onChange, reportCodeSlot]);

  useImperativeHandle(
    ref,
    (): BoardHandle => ({
      getElements: elements,
      setElements: (next) => apiRef.current?.updateScene({ elements: next }),
      convert,
      seedTemplate: (skeletons: Skeleton[]) => {
        seedSkeletonsRef.current = skeletons;
        const dark = isDarkTheme(themeId);
        const converted = convert(skeletons, { regenerateIds: false }) as SceneElementLike[];
        const recolored = recolorTemplateElements(converted, dark) ?? converted;
        const next = applyBoardReadingSize(recolored, readingSizeRef.current, { captureFrom: "M" });
        templateRef.current = next;
        apiRef.current?.updateScene({
          elements: next as unknown[],
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // Clear history after seeding so Ctrl+Z undoes student strokes, not the
        // empty board from before the problem loaded.
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          scheduleFitView();
        });
      },
      clearStudentWork: () => {
        // Keep the template and the coach's diagrams; drop only what the
        // student drew. Membership comes from `customData`, which survives
        // conversion — matching on id prefixes did not, which is why this used
        // to wipe the problem statement.
        apiRef.current?.updateScene({
          elements: elements().filter(keepOnClear) as unknown[],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      },
      resetTemplate,
      exportPng: async () => {
        const api = apiRef.current;
        if (!api) return "";
        return captureImage(async () =>
          exportToBlob({
            elements: api.getSceneElements() as never,
            appState: api.getAppState() as never,
            files: api.getFiles() as never,
            mimeType: "image/png",
            quality: 0.8,
          }),
        );
      },
      getStrokes: () => captureStrokes(elements()),
      setTool,
      undo: () => {
        undoBoard();
      },
      scrollToContent: () => apiRef.current?.scrollToContent(),
      zoomIn,
      zoomOut,
      fitView,
      settleFitView,
      fitCodeToSource,
      saveBoard: () => {
        const api = apiRef.current;
        const state = (api?.getAppState() ?? {}) as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
        };
        const kept = elements().filter((element) => !isCoachElement(element));
        return {
          v: 1 as const,
          elements: kept as unknown[],
          appState: {
            scrollX: state.scrollX ?? 0,
            scrollY: state.scrollY ?? 0,
            zoom: state.zoom?.value ?? 1,
          },
        };
      },
      restoreBoard: (nextElements, appState) => {
        // Keep a fit target so landing zooms to problem+code, not the full board.
        templateRef.current = nextElements as unknown[];
        // Drop saved zoom/pan — never pass zoom: undefined (Excalidraw crashes).
        const saved = { ...((appState as Record<string, unknown> | undefined) ?? {}) };
        delete saved.zoom;
        delete saved.scrollX;
        delete saved.scrollY;
        apiRef.current?.updateScene({
          elements: nextElements,
          ...(Object.keys(saved).length > 0 ? { appState: saved } : {}),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          scheduleFitView();
        });
      },
    }),
    [convert, elements, fitCodeToSource, fitView, settleFitView, resetTemplate, scheduleFitView, setTool, themeId, undoBoard, zoomIn, zoomOut],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  const initialData = useMemo(
    () => ({
      appState: {
        viewBackgroundColor: theme.background,
        currentItemStrokeColor: defaultInk(themeId),
        currentItemStrokeWidth: 1,
        currentItemRoughness: 1,
        // Not the hand-drawn default: typed notes should read like notes.
        currentItemFontFamily: FONT_UI,
        currentItemFontSize: DEFAULT_FONT_SIZE,
      },
      // We call settleFitView ourselves — Excalidraw's default fits the entire
      // board and lands the problem as a postage stamp in the corner.
      scrollToContent: false,
    }),
    [theme.background, themeId],
  );

  return (
    <div ref={boardRef} className={interactive ? "lc-board" : "lc-board lc-board-idle"}>
      {interactive && (
        <>
          <BoardToolbar
            active={activeTool}
            onPick={setTool}
            themeId={themeId}
            inkColor={inkColor}
            onInk={setInk}
            strokeWidth={strokeWidth}
            onStrokeWidth={setStrokeWidth}
            pressureSensitive={pressureSensitive}
            onPressureSensitive={setPressureSensitive}
            fontSize={fontSize}
            onFontSize={setFontSize}
            shapesOpen={shapesOpen}
            onToggleShapes={() => {
              if (shapesOpen) {
                setShapesOpen(false);
                return;
              }
              // Shape library is exclusive with drawing tools.
              setTool("selection");
              setShapesOpen(true);
            }}
            onStamp={stamp}
            onStampImported={stampImported}
            onClear={() => {
              rasterInkRef.current?.clear();
              apiRef.current?.updateScene({
                elements: elements().filter(keepOnClear) as unknown[],
                captureUpdate: CaptureUpdateAction.IMMEDIATELY,
              });
            }}
            onReset={resetTemplate}
            onUndo={undoBoard}
            onRedo={redoBoard}
          />
          <div className="lc-map-controls">
            {onThemePick && (
              <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
            )}
            <div className="lc-map-chrome-right">
              <ReadingSizeControl value={readingSize} onChange={setReadingSize} />
              <ZoomControls
                zoomPct={zoomPct}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onFit={fitView}
              />
            </div>
          </div>
        </>
      )}
      {interactive && (
        <RasterInkLayer
          ref={rasterInkRef}
          enabled={interactive}
          tool={inkToolActive ? (activeTool === "eraser" ? "eraser" : "pen") : null}
          strokeWidth={strokeWidth}
          inkColor={inkColor}
          pressureSensitive={pressureSensitive}
          getViewport={getViewport}
          onChange={onChange}
        />
      )}
      {interactive && activeTool === "eraser" && (
        <EraserBrush
          visible={eraserBrush.visible}
          x={eraserBrush.x}
          y={eraserBrush.y}
          diameter={eraserScreenRadius(strokeWidth, eraserBrush.zoom) * 2}
        />
      )}
      <Excalidraw
        viewModeEnabled={!interactive}
        handleKeyboardGlobally={interactive}
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExcalidrawApi;
          scrollUnsubRef.current?.();
          scrollUnsubRef.current =
            apiRef.current.onScrollChange?.((_x, _y, zoom) => {
              const pct = Math.round(zoom.value * 100);
              setZoomPct((current) => (current === pct ? current : pct));
              rasterInkRef.current?.repaint();
              reportCodeSlot();
            }) ?? null;
          const state = apiRef.current.getAppState() as { zoom?: { value?: number } };
          const pct = Math.round((state.zoom?.value ?? 1) * 100);
          setZoomPct((current) => (current === pct ? current : pct));
          apiRef.current.setActiveTool({ type: "hand" });
          reportCodeSlot();
        }}
        onChange={handleSceneChange}
        initialData={initialData}
        UIOptions={UI_OPTIONS}
      />
    </div>
  );
});

interface ToolbarProps {
  active: ToolName;
  onPick: (tool: ToolName) => void;
  themeId: string;
  inkColor: string;
  onInk: (color: string) => void;
  strokeWidth: number;
  onStrokeWidth: (width: number) => void;
  pressureSensitive: boolean;
  onPressureSensitive: (enabled: boolean) => void;
  fontSize: number;
  onFontSize: (size: number) => void;
  shapesOpen: boolean;
  onToggleShapes: () => void;
  onStamp: (shape: ShapeStamp, mods: Record<string, ShapeModValue>, moveAsOne: boolean) => void;
  onStampImported: (item: ImportedLibraryItem, moveAsOne: boolean) => void;
  onClear: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

function BoardToolbar({
  active,
  onPick,
  themeId,
  inkColor,
  onInk,
  strokeWidth,
  onStrokeWidth,
  pressureSensitive,
  onPressureSensitive,
  fontSize,
  onFontSize,
  shapesOpen,
  onToggleShapes,
  onStamp,
  onStampImported,
  onClear,
  onReset,
  onUndo,
  onRedo,
}: ToolbarProps) {
  const showInk =
    active === "freedraw" ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "text";
  const showStrokeSizes = showInk || active === "eraser";
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [configuringImport, setConfiguringImport] = useState<ImportedLibraryItem | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  const [imported, setImported] = useState<ImportedLibraryItem[]>(() => loadImportedLibrary());
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!shapesOpen) {
      setConfiguring(null);
      setConfiguringImport(null);
      setMods({});
      setShapePhase("list");
      setImportError(null);
    }
  }, [shapesOpen]);

  const pickShape = (shape: ShapeStamp) => {
    setConfiguring(shape);
    setConfiguringImport(null);
    setMods({ ...shape.defaults });
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const pickImported = (item: ImportedLibraryItem) => {
    setConfiguring(null);
    setConfiguringImport(item);
    setMods({});
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const backToList = () => {
    setShapePhase("list");
    setConfiguring(null);
    setConfiguringImport(null);
    setMods({});
  };

  const placeConfigured = () => {
    if (configuring) {
      onStamp(configuring, mods, moveAsOne);
    } else if (configuringImport) {
      onStampImported(configuringImport, moveAsOne);
    }
    backToList();
  };

  const onImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const items = parseExcalidrawLibrary(text);
      setImported((current) => {
        const merged = [...current];
        for (const item of items) {
          if (!merged.some((existing) => existing.id === item.id)) merged.push(item);
        }
        saveImportedLibrary(merged);
        return merged;
      });
      setImportError(null);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearImported = () => {
    setImported([]);
    saveImportedLibrary([]);
  };

  const modifierTitle = configuring?.label ?? configuringImport?.name ?? "";

  const pickTool = (tool: ToolName) => {
    if (shapesOpen) onToggleShapes();
    onPick(tool);
  };

  return (
    <div className="lc-toolbar" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map(({ tool, label, hint, emoji }) => (
        <button
          key={tool}
          type="button"
          className={tool === active && !shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
          title={hint}
          aria-label={hint}
          aria-pressed={tool === active && !shapesOpen}
          onClick={() => pickTool(tool)}
        >
          {emoji === "erasersvg" ? (
            <PinkEraserIcon />
          ) : emoji ? (
            <span className="lc-tool-emoji" aria-hidden>
              {emoji}
            </span>
          ) : (
            label
          )}
        </button>
      ))}

      {showInk && (
        <>
          <div className="lc-tool-sep" />
          <div className="lc-tool-group lc-ink-colors" role="group" aria-label="Ink colour">
            {inkSwatches(themeId).map((color) => (
              <button
                key={color}
                type="button"
                className={
                  color === inkColor
                    ? "lc-ink-swatch lc-ink-swatch-active lc-tip-target"
                    : "lc-ink-swatch lc-tip-target"
                }
                style={{ background: color }}
                data-tip="Ink colour"
                data-tip-placement="right"
                aria-label={`Ink ${color}`}
                aria-pressed={color === inkColor}
                onClick={() => onInk(color)}
              />
            ))}
          </div>
        </>
      )}

      {showStrokeSizes && (
        <>
          {!showInk && <div className="lc-tool-sep" />}
          <div className="lc-stroke-controls">
            <StrokeSizeSlider
              value={strokeWidth}
              onChange={onStrokeWidth}
              label={active === "eraser" ? "Eraser size" : "Stroke weight"}
            />
            {active === "freedraw" && (
              <PressureSensitiveToggle
                enabled={pressureSensitive}
                onChange={onPressureSensitive}
              />
            )}
          </div>
        </>
      )}

      {active === "text" && (
        <div className="lc-tool-group" role="group" aria-label="Font size">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={
                size === fontSize
                  ? "lc-tool lc-tool-mini lc-tool-active lc-tip-target"
                  : "lc-tool lc-tool-mini lc-tip-target"
              }
              data-tip={`Text size ${FONT_SIZE_LABELS[size]} (${size}px)`}
              data-tip-placement="right"
              title={`Text size ${FONT_SIZE_LABELS[size]}`}
              aria-pressed={size === fontSize}
              onClick={() => onFontSize(size)}
            >
              {FONT_SIZE_LABELS[size]}
            </button>
          ))}
        </div>
      )}

      <div className="lc-tool-sep" />

      <button
        type="button"
        className={shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
        title="Shapes — data structures and system design"
        aria-label="Shapes"
        aria-expanded={shapesOpen}
        onClick={onToggleShapes}
      >
        ⬡
      </button>

      <button type="button" className="lc-tool lc-tool-labeled" title="Undo" aria-label="Undo" onClick={onUndo}>
        <UndoIcon />
        <span className="lc-tool-caption">Undo</span>
      </button>
      <button type="button" className="lc-tool lc-tool-labeled" title="Redo" aria-label="Redo" onClick={onRedo}>
        <RedoIcon />
        <span className="lc-tool-caption">Redo</span>
      </button>

      {/* Clear lives with the drawing tools, not in the header — it changes the
          canvas, so it belongs beside the things that change the canvas. */}
      <button
        type="button"
        className="lc-tool lc-tool-danger lc-tool-labeled"
        title="Clear your work (keeps the problem and the coach's diagrams)"
        aria-label="Clear your work"
        onClick={onClear}
      >
        <ClearIcon />
        <span className="lc-tool-caption">Clear</span>
      </button>
      <button
        type="button"
        className="lc-tool lc-tool-labeled"
        title="Reset to the original problem layout"
        aria-label="Reset board"
        onClick={() => {
          if (
            window.confirm(
              "Reset the board to the original problem layout? Drawings on the canvas will be cleared.",
            )
          ) {
            onReset();
          }
        }}
      >
        <ResetIcon />
        <span className="lc-tool-caption">Reset</span>
      </button>

      {shapesOpen && (
        <div
          className={
            shapePhase === "mod" ? "lc-shapes lc-shapes-modifying" : "lc-shapes"
          }
          role="menu"
          aria-label="Shape library"
        >
          {shapePhase !== "mod" && (
            <>
              {SHAPE_GROUPS.map((group) => {
                const items =
                  group === "imported"
                    ? []
                    : SHAPES.filter((shape) => shape.group === group);
                if (group === "imported") {
                  if (imported.length === 0) return null;
                  return (
                    <div key={group} className="lc-shape-group">
                      <h4>{group}</h4>
                      {imported.map((item) => {
                        const fading =
                          shapePhase === "fade" &&
                          configuringImport &&
                          configuringImport.id !== item.id;
                        const rising =
                          shapePhase === "fade" &&
                          configuringImport &&
                          configuringImport.id === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="menuitem"
                            className={
                              rising
                                ? "lc-shape lc-shape-rising"
                                : fading
                                  ? "lc-shape lc-shape-fade"
                                  : "lc-shape"
                            }
                            onClick={() => pickImported(item)}
                          >
                            {item.name}
                          </button>
                        );
                      })}
                    </div>
                  );
                }

                if (
                  shapePhase === "fade" &&
                  configuring &&
                  !items.some((shape) => shape.id === configuring.id)
                ) {
                  return (
                    <div key={group} className="lc-shape-group lc-shape-group-fade" aria-hidden>
                      <h4>{group}</h4>
                    </div>
                  );
                }
                return (
                  <div key={group} className="lc-shape-group">
                    <h4 className={shapePhase === "fade" ? "lc-shape-heading-fade" : undefined}>
                      {group}
                    </h4>
                    {items.map((shape) => {
                      const fading =
                        shapePhase === "fade" && configuring && configuring.id !== shape.id;
                      const rising =
                        shapePhase === "fade" && configuring && configuring.id === shape.id;
                      return (
                        <button
                          key={shape.id}
                          type="button"
                          role="menuitem"
                          className={
                            rising
                              ? "lc-shape lc-shape-rising"
                              : fading
                                ? "lc-shape lc-shape-fade"
                                : "lc-shape"
                          }
                          onClick={() => pickShape(shape)}
                        >
                          {shape.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              <div className="lc-shape-import-row">
                <input
                  ref={importRef}
                  type="file"
                  accept=".excalidrawlib,application/json"
                  hidden
                  onChange={(event) => {
                    void onImportFile(event.target.files?.[0] ?? null);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="lc-secondary lc-shape-import lc-tip-target"
                  data-tip="Import a local .excalidrawlib — download from libraries.excalidraw.com on another machine"
                  data-tip-placement="right"
                  onClick={() => importRef.current?.click()}
                >
                  Import library…
                </button>
                {imported.length > 0 && (
                  <button type="button" className="lc-link" onClick={clearImported}>
                    Clear imports
                  </button>
                )}
              </div>
              {importError && <p className="lc-warning">{importError}</p>}
            </>
          )}

          {shapePhase === "mod" && (configuring || configuringImport) && (
            <div className="lc-shape-modifier">
              <button type="button" className="lc-shape-back" onClick={backToList}>
                ← {modifierTitle}
              </button>
              <p className="lc-muted lc-shape-mod-hint">Configure, then place on the board.</p>
              {configuring?.fields.map((field) => (
                <label key={field.key} className="lc-shape-field">
                  <span>{field.label}</span>
                  {field.kind === "int" ? (
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={Number(mods[field.key] ?? configuring.defaults[field.key] ?? 0)}
                      onChange={(event) =>
                        setMods((current) => ({
                          ...current,
                          [field.key]: Number(event.target.value),
                        }))
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={String(mods[field.key] ?? configuring.defaults[field.key] ?? "")}
                      onChange={(event) =>
                        setMods((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") placeConfigured();
                      }}
                    />
                  )}
                </label>
              ))}
              <label className="lc-shape-lock">
                <input
                  type="checkbox"
                  checked={moveAsOne}
                  onChange={(event) => setMoveAsOne(event.target.checked)}
                />
                <span>
                  <strong>Move as one piece</strong>
                  <span className="lc-muted">
                    {" "}
                    — on: drag the whole graphic together; off: move parts separately
                  </span>
                </span>
              </label>
              <button type="button" className="lc-shape-place" onClick={placeConfigured}>
                Place on board
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PinkEraserIcon() {
  return (
    <svg className="lc-tool-svg lc-tool-eraser" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <g transform="rotate(-28 12 12)">
        <rect x="4.5" y="7" width="15" height="11" rx="2.2" fill="#f9a8d4" stroke="#be185d" strokeWidth="1.2" />
        <rect x="4.5" y="7" width="15" height="3.8" rx="1.2" fill="#fb7185" />
        <rect x="4.5" y="15.2" width="15" height="2.8" fill="#fff1f2" opacity="0.95" />
      </g>
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12a9 9 0 0 1 15.5-6.4L21 8"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 3v5h-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12a9 9 0 0 1-15.5 6.4L3 16"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 21v-5h5"
      />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 14 4 9l5-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 9h10.5a5.5 5.5 0 0 1 0 11H13"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m15 14 5-5-5-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 9H9.5a5.5 5.5 0 0 0 0 11H11"
      />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 6h18"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 6V4h8v2"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M10 11v6M14 11v6"
      />
    </svg>
  );
}

function ZoomControls({
  zoomPct,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoomPct: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div className="lc-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="lc-map-btn"
        data-tip="Zoom in"
        data-tip-placement="left"
        aria-label="Zoom in"
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip="Zoom out"
        data-tip-placement="left"
        aria-label="Zoom out"
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip={`Center view (${zoomPct}%)`}
        data-tip-placement="left"
        aria-label={`Center view, ${zoomPct}% zoom`}
        onClick={onFit}
      >
        ⊡
      </button>
    </div>
  );
}