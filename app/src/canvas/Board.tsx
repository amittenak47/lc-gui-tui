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

import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToCanvas,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  SHAPES,
  SHAPE_GROUPS,
  resolveShapeMods,
  DEFAULT_SHAPE_PALETTE,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import { healBoardLayout } from "./healBoardLayout";
import { healScratchpadGeometry, SCRATCH_PAGE_W } from "../templates/scratchpad";
import { regionFrameId, regionFramesOf, syncRegionLayout, type LayoutElement } from "../templates/regionLayout";
import { recolorTemplateElements } from "../templates/problemBoard";
import { codeFrameHeightForSource, codeLabelReserve } from "../util/solutionPad";
import { REGION_MIN, REGIONS, STUDENT_REGION_ORDER, type RegionId } from "../templates/regions";
import {
  BOARD_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_UI,
  type Skeleton,
} from "../templates/skeleton";
import { BackgroundPalette } from "../components/BackgroundPalette";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ReadingSizeControl } from "../components/ReadingSizeControl";
import { FontSizeSlider } from "./FontSizeSlider";
import { useIsMobile } from "../util/mobile";
import { isDarkTheme } from "../theme/appThemes";
import {
  loadBoardReadingSize,
  saveBoardReadingSize,
  statementLinePitch,
  type BoardReadingSize,
} from "../modes/codeFontSize";

/** Default wrap width for the text tool (canvas units). User can resize the box. */
const TEXT_WRAP_WIDTH = 420;
import { applyBoardReadingSize } from "../modes/applyBoardReadingSize";
import type { BoardHandle, ScreenRect, ToolName } from "./BoardHandle";
import { captureImage, captureStrokes, type SceneElementLike } from "./capture";
import { applyMetadata, keepOnClear, isCoachElement } from "./scene";
import {
  applyPageVisibility,
  clearPageVisibility,
  pageBounds,
  type PageableElement,
} from "./pageView";
import { eraserScreenRadius } from "./rasterInk";
import { EraserBrush, type EraserBrushHandle } from "./EraserBrush";
import { RasterInkLayer, type RasterInkHandle } from "./RasterInkLayer";
import { StrokeSizeSlider } from "./StrokeSizeSlider";
import { InkChromeSizeDial } from "./InkChromeSizeDial";
import { loadInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadInkToolPrefs, saveInkToolPrefs } from "../util/inkToolPrefs";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import {
  clampExportScale,
  exportScaleFrom,
  inkOpsBounds,
  inkStrokesFromOps,
  paintInkAtScale,
  unionSceneBounds,
  type InkOp,
  type SceneBounds,
  type ViewportTransform,
} from "./rasterInk";

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
  setActiveTool(tool: {
    type: string;
    customType?: string;
    /** Keep the tool after placing — required for click-around text placement. */
    locked?: boolean;
  }): void;
  setCursor?(cursor: string): void;
  resetCursor?(): void;
  scrollToContent(target?: unknown, opts?: unknown): void;
  onScrollChange?(
    callback: (scrollX: number, scrollY: number, zoom: { value: number }) => void,
  ): () => void;
  history?: { clear(): void };
}

/** Margin around the composite, so ink at the edge isn't flush with it. */
const EXPORT_PADDING = 10;

/**
 * Board PNG with the raster pen ink composited in.
 *
 * `exportToBlob` only knows about scene elements, so a pen-only board exports
 * blank. The fix is to repaint the ink at export scale — never to blit the live
 * overlay, which is viewport-sized and shows only what happens to be on screen.
 *
 * Anchoring the two layers needs to know what scene box the exported image
 * covers. Asking for zero padding pins that to `getCommonBounds` — the same
 * public helper Excalidraw sizes its own export from — so no assumption about
 * its default margin is baked in here. Ink drawn outside the elements' box
 * extends the canvas rather than being cropped.
 */
async function exportBoardBlob(api: ExcalidrawApi, ops: readonly InkOp[]): Promise<Blob> {
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  const files = api.getFiles();
  const plain = () =>
    exportToBlob({
      elements: elements as never,
      appState: appState as never,
      files: files as never,
      mimeType: "image/png",
      quality: 0.8,
    });

  const inkBounds = inkOpsBounds(ops);
  if (!inkBounds || elements.length === 0) return plain();

  const board = await exportToCanvas({
    elements: elements as never,
    appState: appState as never,
    files: files as never,
    exportPadding: 0,
  });
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  const boardBounds: SceneBounds = { minX, minY, maxX, maxY };
  // Also the check that the export really did land on those bounds: an
  // unhonoured padding skews the two axes apart on any non-square board.
  const scale = exportScaleFrom(board.width, board.height, boardBounds);
  if (scale === null) return plain();

  const content = unionSceneBounds(boardBounds, inkBounds)!;
  const bounds: SceneBounds = {
    minX: content.minX - EXPORT_PADDING,
    minY: content.minY - EXPORT_PADDING,
    maxX: content.maxX + EXPORT_PADDING,
    maxY: content.maxY + EXPORT_PADDING,
  };
  const drawScale = clampExportScale(scale, bounds);
  const width = Math.max(1, Math.round((bounds.maxX - bounds.minX) * drawScale));
  const height = Math.max(1, Math.round((bounds.maxY - bounds.minY) * drawScale));

  // Ink gets its own canvas: erase ops composite with `destination-out` and
  // would otherwise cut holes in the board underneath instead of in the ink.
  const inkCanvas = document.createElement("canvas");
  inkCanvas.width = width;
  inkCanvas.height = height;
  const inkCtx = inkCanvas.getContext("2d");
  if (!inkCtx) return plain();
  paintInkAtScale(inkCtx, ops, { x: bounds.minX, y: bounds.minY }, drawScale);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return plain();
  const background = appState.viewBackgroundColor;
  if (appState.exportBackground !== false && typeof background === "string") {
    // The board export only covers its own box; anything the ink added around
    // it would otherwise come out transparent.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(
    board,
    (boardBounds.minX - bounds.minX) * drawScale,
    (boardBounds.minY - bounds.minY) * drawScale,
    (boardBounds.maxX - boardBounds.minX) * drawScale,
    (boardBounds.maxY - boardBounds.minY) * drawScale,
  );
  ctx.drawImage(inkCanvas, 0, 0);

  const composited = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, "image/png", 0.8),
  );
  return composited ?? (await plain());
}

/**
 * Region PNG with raster ink painted in — chat thumbs used to call exportToBlob
 * alone, so pen work looked like a sparse "delta" of shapes only.
 */
async function exportRegionBlob(
  api: ExcalidrawApi,
  ops: readonly InkOp[],
  elements: readonly SceneElementLike[],
  frame: { x: number; y: number; width: number; height: number },
): Promise<Blob> {
  const appState = api.getAppState();
  const files = api.getFiles();
  const frameBounds: SceneBounds = {
    minX: frame.x,
    minY: frame.y,
    maxX: frame.x + frame.width,
    maxY: frame.y + frame.height,
  };
  const regionOps = ops.filter((op) =>
    op.points.some(
      (pt) =>
        pt.x >= frameBounds.minX &&
        pt.y >= frameBounds.minY &&
        pt.x <= frameBounds.maxX &&
        pt.y <= frameBounds.maxY,
    ),
  );

  const plain = () =>
    exportToBlob({
      elements: elements as never,
      appState: {
        ...(appState as object),
        exportBackground: true,
        viewBackgroundColor:
          (appState as { viewBackgroundColor?: string }).viewBackgroundColor ?? "#fff",
      } as never,
      files: files as never,
      mimeType: "image/png",
      quality: 0.7,
      exportPadding: 16,
    });

  if (elements.length === 0) return plain();

  const board = await exportToCanvas({
    elements: elements as never,
    appState: {
      ...(appState as object),
      exportBackground: true,
      viewBackgroundColor:
        (appState as { viewBackgroundColor?: string }).viewBackgroundColor ?? "#fff",
    } as never,
    files: files as never,
    exportPadding: 0,
  });
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  const boardBounds: SceneBounds = { minX, minY, maxX, maxY };
  const scale = exportScaleFrom(board.width, board.height, boardBounds);
  if (scale === null || regionOps.length === 0) return plain();

  const content = unionSceneBounds(boardBounds, inkOpsBounds(regionOps) ?? boardBounds)!;
  const bounds: SceneBounds = {
    minX: content.minX - EXPORT_PADDING,
    minY: content.minY - EXPORT_PADDING,
    maxX: content.maxX + EXPORT_PADDING,
    maxY: content.maxY + EXPORT_PADDING,
  };
  const drawScale = clampExportScale(scale, bounds);
  const width = Math.max(1, Math.round((bounds.maxX - bounds.minX) * drawScale));
  const height = Math.max(1, Math.round((bounds.maxY - bounds.minY) * drawScale));

  const inkCanvas = document.createElement("canvas");
  inkCanvas.width = width;
  inkCanvas.height = height;
  const inkCtx = inkCanvas.getContext("2d");
  if (!inkCtx) return plain();
  paintInkAtScale(inkCtx, regionOps, { x: bounds.minX, y: bounds.minY }, drawScale);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return plain();
  const background =
    (appState as { viewBackgroundColor?: string }).viewBackgroundColor ?? "#fff";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(
    board,
    (boardBounds.minX - bounds.minX) * drawScale,
    (boardBounds.minY - bounds.minY) * drawScale,
    (boardBounds.maxX - boardBounds.minX) * drawScale,
    (boardBounds.maxY - boardBounds.minY) * drawScale,
  );
  ctx.drawImage(inkCanvas, 0, 0);

  const composited = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, "image/png", 0.75),
  );
  return composited ?? (await plain());
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 1.75;
const ZOOM_STEP = 1.15;
/** Matches Excalidraw's internal wheel-zoom step (not our button ZOOM_STEP). */
const WHEEL_ZOOM_STEP = 0.1;

function clampZoom(value: number, min = ZOOM_MIN): number {
  return Math.min(ZOOM_MAX, Math.max(min, value));
}

/** Read a `--lc-safe-*` px length from the document root (mobile nav bar, etc.). */
function safeCssPx(name: "--lc-safe-top" | "--lc-safe-bottom" | "--lc-safe-left" | "--lc-safe-right"): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Viewport chrome around the fitted template page (toolbar top, map controls bottom). */
function mobilePageInsets(toolbarH: number): {
  top: number;
  left: number;
  right: number;
  bottom: number;
} {
  return {
    top: Math.max(34, Math.round(toolbarH) + 2),
    left: 2,
    right: 2,
    // Bottom chrome overlays the page; keep a thin pad off the physical edge.
    bottom: 8,
  };
}

/** Desktop page fit — fill under the toolbar to the board bottom; chrome overlays. */
function desktopPageInsets(toolbarH: number, chromeHidden: boolean): {
  top: number;
  left: number;
  right: number;
  bottom: number;
} {
  return {
    top: Math.max(40, Math.round(toolbarH) + 2),
    left: 4,
    right: 4,
    // Map chrome + coach fold sit on top of the page — do not reserve their height.
    bottom: chromeHidden ? 8 : 12,
  };
}

/**
 * Measure the live chrome hole so the dashed frame can touch the toolbar and
 * run to the board bottom (controls overlay the page; coach does not shrink it).
 */
function measureChromeInsets(
  boardEl: HTMLElement | null,
  toolbarH: number,
  chromeHidden: boolean,
  mobile: boolean,
): { top: number; left: number; right: number; bottom: number } {
  const fallback = mobile
    ? mobilePageInsets(toolbarH)
    : desktopPageInsets(toolbarH, chromeHidden);
  if (!boardEl) return fallback;
  const board = boardEl.getBoundingClientRect();
  if (board.width < 8 || board.height < 8) return fallback;

  const toolbar = boardEl.querySelector(".lc-toolbar") as HTMLElement | null;
  const top = toolbar
    ? Math.max(2, Math.round(toolbar.getBoundingClientRect().bottom - board.top + 2))
    : fallback.top;

  return {
    top,
    left: fallback.left,
    right: fallback.right,
    bottom: fallback.bottom,
  };
}

/**
 * Keep the viewport inside the open template page on mobile.
 * Zoomed in: pan freely within the box. At fit zoom: locked (no empty gutter).
 */
function clampScrollToBounds(
  scrollX: number,
  scrollY: number,
  zoom: number,
  viewWidth: number,
  viewHeight: number,
  bounds: SceneBounds,
  inset: { top: number; left: number; right: number; bottom: number },
): { scrollX: number; scrollY: number } {
  const availW = Math.max(1, viewWidth - inset.left - inset.right);
  const availH = Math.max(1, viewHeight - inset.top - inset.bottom);
  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const visW = availW / zoom;
  const visH = availH / zoom;

  let nextX: number;
  let nextY: number;
  if (contentW <= visW + 0.5) {
    nextX = inset.left / zoom - bounds.minX + (visW - contentW) / 2;
  } else {
    const maxX = inset.left / zoom - bounds.minX;
    const minX = (viewWidth - inset.right) / zoom - bounds.maxX;
    nextX = Math.min(maxX, Math.max(minX, scrollX));
  }
  if (contentH <= visH + 0.5) {
    nextY = inset.top / zoom - bounds.minY + (visH - contentH) / 2;
  } else {
    const maxY = inset.top / zoom - bounds.minY;
    const minY = (viewHeight - inset.bottom) / zoom - bounds.maxY;
    nextY = Math.min(maxY, Math.max(minY, scrollY));
  }
  return { scrollX: nextX, scrollY: nextY };
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
  /**
   * Mobile "page": the one student region the viewport is fitted to. `null` on
   * desktop, where the whole stacked column stays one wide canvas.
   *
   * The scene is untouched either way — this only changes what `fitView` aims
   * at and whether the code dock is reported.
   */
  mobileRegion?: string | null;
  /**
   * Chrome that belongs in the middle of the board's bottom row — the mobile
   * page turner. It lives in the same flex row as Appearance and the zoom
   * cluster rather than floating over them, which is the only way the three
   * can share a baseline and never overlap.
   */
  bottomCenter?: ReactNode;
  /** Show lined-paper toggle in the map chrome. */
  linedPaperToggle?: boolean;
  /** Show S/M/L reading size (problem boards on mobile — not scratchpad). */
  showReadingSize?: boolean;
  /** Optional fold handle under the bottom chrome (coach closed → open). */
  coachFold?: ReactNode;
}

const INK_COLORS_LIGHT = ["#1e1e1e", "#64748b", "#b45309", "#1d4ed8", "#166534", "#b91c1c"] as const;
const INK_COLORS_DARK = ["#f3f4f6", "#94a3b8", "#fb923c", "#60a5fa", "#4ade80", "#f87171"] as const;

function defaultInk(themeId: string): string {
  return isDarkTheme(themeId) ? INK_COLORS_DARK[0] : INK_COLORS_LIGHT[0];
}

function inkSwatches(themeId: string): readonly string[] {
  return isDarkTheme(themeId) ? INK_COLORS_DARK : INK_COLORS_LIGHT;
}

function resolveInkColor(themeId: string, preferred: string | null | undefined): string {
  const swatches = inkSwatches(themeId);
  if (preferred && swatches.includes(preferred)) return preferred;
  return defaultInk(themeId);
}

const TOOLS: Array<{ tool: ToolName; label: string; hint: string; emoji?: string }> = [
  { tool: "hand", label: "hand", hint: "Pan — drag to move; scroll wheel zooms", emoji: "✋" },
  { tool: "selection", label: "⬚", hint: "Select — resize region boxes (they stay locked in place) or move your work" },
  { tool: "freedraw", label: "Pen", hint: "Pen", emoji: "✏️" },
  { tool: "eraser", label: "Eraser", hint: "Eraser — only removes ink under the brush", emoji: "erasersvg" },
  { tool: "text", label: "T", hint: "Text — click to place (Enter finishes, Shift+Enter for a new line)" },
  { tool: "rectangle", label: "▭", hint: "Rectangle" },
  { tool: "ellipse", label: "◯", hint: "Ellipse" },
  { tool: "arrow", label: "↗", hint: "Arrow" },
];

/** Layouts where you ink — floating pen/eraser swap sits above each of these. */
interface InkChromePos {
  left: number;
  top: number;
}

type InkChromePhase = "in" | "shown" | "out";

interface InkChromeState extends InkChromePos {
  phase: InkChromePhase;
}

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

function sameBounds(a: SceneBounds | null, b: SceneBounds | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
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
    mobileRegion = null,
    bottomCenter = null,
    linedPaperToggle = false,
    showReadingSize = false,
    coachFold = null,
  },
  ref,
) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const [activeTool, setActiveTool] = useState<ToolName>("hand");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const inkPrefsRef = useRef(loadInkToolPrefs());
  const [inkColor, setInkColor] = useState(() =>
    resolveInkColor(themeId, inkPrefsRef.current.inkColor),
  );
  const [penStrokeWidth, setPenStrokeWidth] = useState(() => inkPrefsRef.current.penWidth);
  const [eraserStrokeWidth, setEraserStrokeWidth] = useState(() => inkPrefsRef.current.eraserWidth);
  const strokeWidth = activeTool === "eraser" ? eraserStrokeWidth : penStrokeWidth;
  const [inkChrome, setInkChrome] = useState<InkChromeState | null>(null);
  const [inkHandedness, setInkHandedness] = useState<InkHandedness>(() => loadInkHandedness());
  const [stampTrash, setStampTrash] = useState<{
    left: number;
    top: number;
    ids: string[];
  } | null>(null);
  const inkChromeHideRef = useRef<number | null>(null);
  const inkChromeExitRef = useRef<number | null>(null);
  const inkChromeShowRef = useRef<number | null>(null);
  const inkTrailRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const inkHandednessRef = useRef(inkHandedness);
  inkHandednessRef.current = inkHandedness;
  const [linedPaper, setLinedPaper] = useState(false);
  const linedPaperRef = useRef(linedPaper);
  linedPaperRef.current = linedPaper;
  const [linedSlot, setLinedSlot] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    gap: number;
    phase: number;
  } | null>(null);
  const lastLinedSlotRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
    gap: number;
    phase: number;
  } | null>(null);
  const [mapChromeHidden, setMapChromeHidden] = useState(false);
  const mapChromeHiddenRef = useRef(mapChromeHidden);
  mapChromeHiddenRef.current = mapChromeHidden;
  const [pressureSensitive, setPressureSensitiveState] = useState(
    () => inkPrefsRef.current.pressureSensitive,
  );
  const eraserBrushRef = useRef<EraserBrushHandle | null>(null);
  const rasterInkRef = useRef<RasterInkHandle>(null);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  /** Effective zoom-out floor as a percent — page fit on mobile, else ZOOM_MIN. */
  const [zoomFloorPct, setZoomFloorPct] = useState(() => Math.round(ZOOM_MIN * 100));
  /** Scene box of the open mobile page — clips the raster ink layer to it. */
  const [inkClip, setInkClip] = useState<SceneBounds | null>(null);
  /** Floor zoom for the open mobile page (fit-to-chrome); null on desktop. */
  const fitZoomMinRef = useRef<number | null>(null);
  /** Live page bounds for scroll clamping (same box as inkClip). */
  const pageBoundsRef = useRef<SceneBounds | null>(null);
  /** Measured toolbar height so fitView lands the template under it. */
  const [toolbarHeight, setToolbarHeight] = useState(36);
  const toolbarHeightRef = useRef(toolbarHeight);
  toolbarHeightRef.current = toolbarHeight;
  const clampingScrollRef = useRef(false);
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
  /** Read by `fitView` and `reportCodeSlot`, which must not re-bind per page. */
  const mobileRegionRef = useRef<string | null>(mobileRegion);
  const strokeWidthRef = useRef(strokeWidth);
  strokeWidthRef.current = strokeWidth;
  /** Zoom at the last brush sample, so a size change can resize the ring. */
  const brushZoomRef = useRef(1);
  /** Last text element the student was editing — for hand-tool handoff. */
  const editingTextIdRef = useRef<string | null>(null);
  /** Enter (not Shift+Enter) finished the wysiwyg — always leave the text tool. */
  const textFinishedViaEnterRef = useRef(false);
  /** Shift held → text corner-drag keeps wrap width instead of free resize. */
  const shiftHeldRef = useRef(false);
  /** Read by the pointer listeners, which must not re-bind on every tool change. */
  const activeToolRef = useRef<ToolName>(activeTool);
  activeToolRef.current = activeTool;
  /** True while a text tap is being replayed, so it isn't intercepted again. */
  const replayingTextTapRef = useRef(false);
  /** Where a press landed while an empty text box was open, pending its replay. */
  const pendingTextTapRef = useRef<{
    clientX: number;
    clientY: number;
    pointerType: string;
  } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeldRef.current = event.type === "keydown";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", () => {
      shiftHeldRef.current = false;
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  /**
   * Excalidraw's single-key shortcuts belong to a UI this app hides.
   *
   * `handleKeyboardGlobally` puts its key handler on `document`, so every bare
   * letter and digit is live: `1`–`9` and `v r d o a l p t e h k f` swap the
   * tool out from under the pen, and `s` / `g` pop open the stroke and
   * background colour pickers — the palette that appears "from nowhere". None
   * of them are reachable from our toolbar, so none of them should be reachable
   * from the keyboard either.
   *
   * The rule is deliberately blunt: an unmodified key that produces a single
   * character never reaches Excalidraw. Everything editing needs — Ctrl/⌘
   * combos, Escape, Delete, Tab, arrows, and Space for pan-drag — is allowed
   * through, and typing is untouched because a focused text box, Monaco, or any
   * input is exempt. The `?` button in the toolbar lists what survives.
   */
  useEffect(() => {
    if (!interactive) return;
    const guard = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === " ") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (
          target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.closest(".lc-code-dock, .monaco-editor")
        ) {
          return;
        }
      }
      // Capture phase: Excalidraw's document listener never sees it.
      event.stopPropagation();
    };
    window.addEventListener("keydown", guard, true);
    window.addEventListener("keypress", guard, true);
    window.addEventListener("keyup", guard, true);
    return () => {
      window.removeEventListener("keydown", guard, true);
      window.removeEventListener("keypress", guard, true);
      window.removeEventListener("keyup", guard, true);
    };
  }, [interactive]);

  /**
   * Placing the next text box in one tap.
   *
   * Excalidraw refuses to create a text element while another is being edited —
   * `handleTextOnPointerDown` returns early with "clicking outside should only
   * finalize it, not create another". With a locked text tool that costs two
   * taps for every box after the first: one to throw the empty box away, one to
   * place the new one. On a tablet that reads as the tool not working.
   *
   * So the press is intercepted while an *empty* box is open: commit it, then
   * replay the same press at the same point once Excalidraw has cleared its
   * editing state. A box with text in it is left alone — that gesture already
   * commits and hands back to the hand tool, which is what it should do.
   */
  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    const onPointerDown = (event: PointerEvent) => {
      pendingTextTapRef.current = null;
      if (replayingTextTapRef.current) return;
      if (activeToolRef.current !== "text") return;
      const editable = document.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg");
      if (!editable || event.target === editable) return;
      if (editable.value.trim().length > 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(".excalidraw")) return;
      if (
        target.closest(
          ".lc-toolbar, .lc-map-controls, .lc-code-dock, .lc-pager, .lc-ink-chrome",
        )
      ) {
        return;
      }

      // The press itself is left alone — it is what commits (and, being empty,
      // deletes) the open box. Only the placement Excalidraw refuses to do is
      // added, once its own gesture has finished.
      pendingTextTapRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerType: event.pointerType || "mouse",
      };
    };

    const onPointerUp = () => {
      const tap = pendingTextTapRef.current;
      pendingTextTapRef.current = null;
      if (!tap || activeToolRef.current !== "text") return;

      const replay = () => {
        replayingTextTapRef.current = false;
        // Excalidraw commits the empty box on this pointerup; if something kept
        // it open, replaying would only be refused again.
        if (document.querySelector("textarea.excalidraw-wysiwyg")) return;
        const canvas =
          root.querySelector("canvas.excalidraw__canvas.interactive") ??
          root.querySelector("canvas.excalidraw__canvas");
        if (!(canvas instanceof Element)) return;
        const init: PointerEventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: tap.clientX,
          clientY: tap.clientY,
          pointerId: 1,
          pointerType: tap.pointerType,
          isPrimary: true,
          button: 0,
        };
        canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
        canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      };

      replayingTextTapRef.current = true;
      // Two frames: Excalidraw's submit runs through React state first.
      window.requestAnimationFrame(() => window.requestAnimationFrame(replay));
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [interactive]);

  // Enter commits the text box; Shift+Enter inserts a newline (Excalidraw's default).
  useEffect(() => {
    if (!interactive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.classList.contains("excalidraw-wysiwyg")) return;
      event.preventDefault();
      event.stopPropagation();
      textFinishedViaEnterRef.current = true;
      target.blur();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [interactive]);

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

  /**
   * The board as everything above it sees it: paging undone.
   *
   * Capture, the coach's thumbnails, autosave and `board.json` all come through
   * here, so a hidden page is a rendering state and nothing else — the file on
   * disk is identical whether it was written from a tablet or a desktop.
   */
  const elements = useCallback((): SceneElementLike[] => {
    const live = (apiRef.current?.getSceneElements() ?? []) as SceneElementLike[];
    if (mobileRegionRef.current === null) return live;
    return clearPageVisibility(live as unknown as PageableElement[]) as unknown as SceneElementLike[];
  }, []);

  /**
   * Re-hide whatever the open page is not, after the scene changed, and keep
   * the ink clip on the same box. Both are derived from the live frames, so
   * resizing a region moves the page and its ink together.
   */
  const syncPageVisibility = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const live = api.getSceneElements() as unknown as PageableElement[];
    const page = mobileRegionRef.current;

    const bounds = pageBounds(live, page);
    pageBoundsRef.current = bounds;
    setInkClip((current) => (sameBounds(current, bounds) ? current : bounds));

    const next = applyPageVisibility(live, page);
    if (!next) return;
    api.updateScene({
      elements: next as unknown[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  const reportCodeSlot = useCallback(() => {
    const api = apiRef.current;
    const notify = onCodeSlotRef.current;
    if (!api || !notify) return;

    // Mobile paging: Monaco only exists on the Code page. Leaving the page has
    // to clear the slot, or the dock hangs over whatever region is now fitted.
    const page = mobileRegionRef.current;
    if (page !== null && page !== "code") {
      if (lastCodeSlotRef.current !== null) {
        lastCodeSlotRef.current = null;
        notify(null);
      }
      return;
    }

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

  /** Keep lined paper clipped to the open template frame (screen space). */
  const reportLinedSlot = useCallback(() => {
    if (!linedPaperRef.current) {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlot(null);
      }
      return;
    }
    const api = apiRef.current;
    const bounds = pageBoundsRef.current;
    if (!api || !bounds) {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlot(null);
      }
      return;
    }
    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
    };
    const zoom = state.zoom?.value ?? 1;
    const scrollX = state.scrollX ?? 0;
    const scrollY = state.scrollY ?? 0;
    // Keep lines inside the dashed stroke.
    const pad = Math.max(2, Math.round(3 * zoom));
    const left = roundPx((bounds.minX + scrollX) * zoom + pad);
    const top = roundPx((bounds.minY + scrollY) * zoom + pad);
    const width = roundPx(Math.max(0, (bounds.maxX - bounds.minX) * zoom - pad * 2));
    const height = roundPx(Math.max(0, (bounds.maxY - bounds.minY) * zoom - pad * 2));
    // Match statement prose pitch so rules sit under each text line.
    const pitchScene = statementLinePitch(readingSizeRef.current);
    const gap = Math.max(12, Math.round(pitchScene * zoom));

    let phase = 0;
    const elements = api.getSceneElements() as Array<{
      id?: string;
      type?: string;
      y?: number;
      fontSize?: number;
    }>;
    const body = elements.find(
      (el) => el.type === "text" && typeof el.id === "string" && el.id.includes("-body-"),
    );
    if (body && typeof body.y === "number") {
      const fontSize =
        typeof body.fontSize === "number" && body.fontSize > 0
          ? body.fontSize
          : pitchScene / (40 / 28);
      // Rule under the glyph baseline of the first statement line.
      const baselineScene = body.y + fontSize * 0.82;
      const baselinePx = (baselineScene + scrollY) * zoom;
      const rel = baselinePx - top;
      // Gradient paints the rule at the end of each gap tile.
      phase = ((rel - gap + 1) % gap + gap) % gap;
    }

    const next = { left, top, width, height, gap, phase: roundPx(phase) };
    const prev = lastLinedSlotRef.current;
    if (
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.gap === next.gap &&
      prev.phase === next.phase
    ) {
      return;
    }
    lastLinedSlotRef.current = next;
    setLinedSlot(next);
  }, []);

  /**
   * Near-pen undo/redo/eraser cluster — appears after a short pause at stroke
   * end, above recent writing, then fades after ~8s. Never tracks mid-stroke.
   */
  const clearInkChromeTimers = useCallback(() => {
    if (inkChromeHideRef.current != null) {
      window.clearTimeout(inkChromeHideRef.current);
      inkChromeHideRef.current = null;
    }
    if (inkChromeExitRef.current != null) {
      window.clearTimeout(inkChromeExitRef.current);
      inkChromeExitRef.current = null;
    }
    if (inkChromeShowRef.current != null) {
      window.clearTimeout(inkChromeShowRef.current);
      inkChromeShowRef.current = null;
    }
  }, []);

  const placeInkChrome = useCallback((clientX: number, clientY: number) => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    // Buttons (~24) × 3 + gaps + radial dial (~38)
    const clusterW = 24 * 3 + 4 + 38;
    const clusterH = 38;
    const pad = 12;
    const hand = inkHandednessRef.current;

    const now = performance.now();
    // Keep a longer trail, but ignore the tip — sit over older ink so the hand
    // doesn't cover the chrome.
    const trail = inkTrailRef.current.filter((point) => now - point.t < 4000);
    inkTrailRef.current = trail;
    const older = trail.filter((point) => now - point.t >= 700);
    const histPts = older.length > 0 ? older : trail.length > 0 ? trail : [{ x: clientX, y: clientY, t: now }];
    const histX = histPts.reduce((sum, point) => sum + point.x, 0) / histPts.length;
    const histY = histPts.reduce((sum, point) => sum + point.y, 0) / histPts.length;
    const histMinX = Math.min(...histPts.map((point) => point.x));
    const histMaxX = Math.max(...histPts.map((point) => point.x));
    const histMinY = Math.min(...histPts.map((point) => point.y));
    const histMaxY = Math.max(...histPts.map((point) => point.y));

    // Writing direction: historical → tip. Place chrome opposite that vector.
    let dx = clientX - histX;
    let dy = clientY - histY;
    const mag = Math.hypot(dx, dy);
    if (mag < 8) {
      // Stationary / short stroke: default above historical top.
      dx = 0;
      dy = 1;
    } else {
      dx /= mag;
      dy /= mag;
    }

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const offset = 40;
    let centerX: number;
    let centerY: number;

    if (absDy >= absDx * 1.15) {
      // Mostly vertical: use historical top/bottom edge + pad away from tip.
      centerX = histX + (hand === "right" ? -10 : 10);
      centerY = dy > 0 ? histMinY - pad - clusterH / 2 : histMaxY + pad + clusterH / 2;
    } else if (absDx >= absDy * 1.15) {
      // Mostly horizontal: sit beside historical ink, opposite writing.
      centerY = histY;
      centerX = dx > 0 ? histMinX - pad - clusterW / 2 : histMaxX + pad + clusterW / 2;
      // Nudge slightly toward the non-writing (palm) side vertically if needed.
      centerY += hand === "right" ? -6 : 6;
    } else {
      // Diagonal: blend — opposite direction from historical center toward tip.
      centerX = histX - dx * offset;
      centerY = histY - dy * offset;
      // Prefer historical bbox edges along the dominant axis of the blend.
      if (dy > 0) centerY = Math.min(centerY, histMinY - pad - clusterH / 2);
      else centerY = Math.max(centerY, histMaxY + pad + clusterH / 2);
      if (dx > 0) centerX = Math.min(centerX, histMinX - pad - clusterW / 2);
      else centerX = Math.max(centerX, histMaxX + pad + clusterW / 2);
    }

    let left = centerX - rect.left - clusterW / 2;
    let top = centerY - rect.top - clusterH / 2;
    left = Math.max(8, Math.min(left, rect.width - clusterW - 8));
    top = Math.max(8, Math.min(top, rect.height - clusterH - 8));
    const next = { left: roundPx(left), top: roundPx(top) };

    setInkChrome((current) => {
      if (!current) return { ...next, phase: "in" };
      if (current.left === next.left && current.top === next.top && current.phase !== "out") {
        return current;
      }
      return {
        ...next,
        phase: current.phase === "out" ? "in" : current.phase === "in" ? "in" : "shown",
      };
    });

    if (inkChromeHideRef.current != null) {
      window.clearTimeout(inkChromeHideRef.current);
      inkChromeHideRef.current = null;
    }
    if (inkChromeExitRef.current != null) {
      window.clearTimeout(inkChromeExitRef.current);
      inkChromeExitRef.current = null;
    }

    inkChromeHideRef.current = window.setTimeout(() => {
      setInkChrome((current) => (current ? { ...current, phase: "out" } : null));
      inkChromeHideRef.current = null;
      inkChromeExitRef.current = window.setTimeout(() => {
        setInkChrome(null);
        inkChromeExitRef.current = null;
      }, 200);
    }, 8000);
  }, []);

  const onInkStrokeMove = useCallback((clientX: number, clientY: number) => {
    // Track trail only — never mount chrome mid-stroke (perf + less obtrusive).
    const now = performance.now();
    const trail = inkTrailRef.current;
    const last = trail[trail.length - 1];
    if (!last || now - last.t > 24 || Math.hypot(clientX - last.x, clientY - last.y) > 6) {
      trail.push({ x: clientX, y: clientY, t: now });
      if (trail.length > 120) trail.splice(0, trail.length - 120);
    }
    if (inkChromeShowRef.current != null) {
      window.clearTimeout(inkChromeShowRef.current);
      inkChromeShowRef.current = null;
    }
    // Hide any lingering chrome as soon as writing resumes.
    if (inkChromeHideRef.current != null || inkChromeExitRef.current != null) {
      clearInkChromeTimers();
    }
    setInkChrome((current) => (current ? null : current));
  }, [clearInkChromeTimers]);

  const onInkStrokeEnd = useCallback(
    (clientX: number, clientY: number) => {
      const now = performance.now();
      inkTrailRef.current.push({ x: clientX, y: clientY, t: now });
      if (inkChromeShowRef.current != null) {
        window.clearTimeout(inkChromeShowRef.current);
      }
      // Micro-delay so a short pause mid-word doesn't flash the chrome.
      inkChromeShowRef.current = window.setTimeout(() => {
        inkChromeShowRef.current = null;
        placeInkChrome(clientX, clientY);
      }, 280);
    },
    [placeInkChrome],
  );

  const persistInkPrefs = useCallback(
    (patch: Partial<{ penWidth: number; eraserWidth: number; pressureSensitive: boolean; inkColor: string }>) => {
      const next = {
        penWidth: patch.penWidth ?? penStrokeWidth,
        eraserWidth: patch.eraserWidth ?? eraserStrokeWidth,
        pressureSensitive: patch.pressureSensitive ?? pressureSensitive,
        inkColor: patch.inkColor ?? inkColor,
      };
      inkPrefsRef.current = next;
      saveInkToolPrefs(next);
    },
    [penStrokeWidth, eraserStrokeWidth, pressureSensitive, inkColor],
  );

  const setStrokeWidth = useCallback((width: number) => {
    if (activeTool === "eraser") {
      setEraserStrokeWidth(width);
      persistInkPrefs({ eraserWidth: width });
    } else {
      setPenStrokeWidth(width);
      persistInkPrefs({ penWidth: width });
      apiRef.current?.updateScene({ appState: { currentItemStrokeWidth: width } });
    }
    if (activeTool === "eraser") {
      apiRef.current?.setCursor?.(eraserCanvasCursorCss());
    }
  }, [activeTool, persistInkPrefs]);

  const setPressureSensitive = useCallback(
    (enabled: boolean) => {
      setPressureSensitiveState(enabled);
      persistInkPrefs({ pressureSensitive: enabled });
    },
    [persistInkPrefs],
  );

  const setTool = useCallback((tool: ToolName) => {
    if (tool === "freedraw") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcInk", locked: false });
      apiRef.current?.resetCursor?.();
    } else if (tool === "eraser") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcEraser", locked: false });
      apiRef.current?.setCursor?.(eraserCanvasCursorCss());
    } else if (tool === "text") {
      // Locked keeps Excalidraw on the text tool after a click — otherwise it
      // flips to selection and the crosshair dies before you can place again.
      // Do not resetCursor here: setActiveTool already sets the text crosshair.
      apiRef.current?.setActiveTool({ type: "text", locked: true });
    } else {
      apiRef.current?.setActiveTool({ type: tool, locked: false });
      apiRef.current?.resetCursor?.();
    }
    // The brush node unmounts with the tool; hiding it here keeps a stale ring
    // off the canvas for the frame between the click and the unmount.
    if (tool !== "eraser") eraserBrushRef.current?.setVisible(false);

    // Leaving the text tool: drop empty placeholders left from click-around.
    if (tool !== "text" && activeTool === "text") {
      const api = apiRef.current;
      if (api) {
        const current = api.getSceneElements() as Array<{
          id: string;
          type: string;
          text?: string;
          originalText?: string;
          isDeleted?: boolean;
          customData?: { lcRegion?: string; lcVizId?: string } | null;
          [key: string]: unknown;
        }>;
        let changed = false;
        const next = current.map((el) => {
          if (el.isDeleted || el.type !== "text") return el;
          if (el.customData?.lcRegion || el.customData?.lcVizId) return el;
          const raw = (el.originalText ?? el.text ?? "").trim();
          if (raw.length > 0) return el;
          changed = true;
          return { ...el, isDeleted: true };
        });
        if (changed) {
          api.updateScene({
            elements: next,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      }
    }

    setActiveTool(tool);
  }, [activeTool]);

  const handleStylusAccessory = useCallback(
    (event: PointerEvent) => {
      // Stylus only — never steal mouse right-click.
      if (event.pointerType !== "pen" && event.pointerType !== "eraser") return false;
      // Common mappings: eraser tip (button 5 / buttons bit 5), barrel (button 2).
      const eraserTip =
        event.pointerType === "eraser" || event.button === 5 || (event.buttons & 32) !== 0;
      const barrel = event.button === 2 || event.button === 5;
      if (!eraserTip && !barrel) return false;
      const toEraser = activeToolRef.current !== "eraser";
      if (shapesOpen) setShapesOpen(false);
      setTool(toEraser ? "eraser" : "freedraw");
      placeInkChrome(event.clientX, event.clientY);
      return true;
    },
    [setTool, shapesOpen, placeInkChrome],
  );

  useEffect(() => {
    const onHand = (event: Event) => {
      const detail = (event as CustomEvent<InkHandedness>).detail;
      if (detail === "left" || detail === "right") {
        setInkHandedness(detail);
      } else {
        setInkHandedness(loadInkHandedness());
      }
    };
    window.addEventListener("lc-ink-handedness", onHand);
    return () => window.removeEventListener("lc-ink-handedness", onHand);
  }, []);

  const deleteSelectedStamps = useCallback(() => {
    const api = apiRef.current;
    if (!api || !stampTrash) return;
    const kill = new Set(stampTrash.ids);
    const current = api.getSceneElements() as Array<{
      id: string;
      isDeleted?: boolean;
      [key: string]: unknown;
    }>;
    api.updateScene({
      elements: current.map((el) => (kill.has(el.id) ? { ...el, isDeleted: true } : el)),
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setStampTrash(null);
    onChange?.();
  }, [onChange, stampTrash]);

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
  //
  // Nothing here touches React state: a pen streams `pointermove` at the panel's
  // refresh rate, and re-rendering Board per sample was what made erasing feel
  // sluggish. Position/size go straight to the node, coalesced to one rAF, and
  // the ring's mount/unmount is the only thing React still decides.
  useEffect(() => {
    if (!interactive || activeTool !== "eraser") return;
    const root = boardRef.current;
    if (!root) return;

    let frame = 0;
    let pending: { x: number; y: number; zoom: number } | null = null;
    let visible = false;

    const flush = () => {
      frame = 0;
      const next = pending;
      pending = null;
      const brush = eraserBrushRef.current;
      if (!brush || !next) return;
      brush.setDiameter(eraserScreenRadius(strokeWidthRef.current, next.zoom) * 2);
      brush.move(next.x, next.y);
      if (!visible) {
        visible = true;
        brush.setVisible(true);
      }
    };

    const hide = () => {
      pending = null;
      if (!visible) return;
      visible = false;
      eraserBrushRef.current?.setVisible(false);
    };

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
        hide();
        return;
      }
      const boardRect = root.getBoundingClientRect();
      const { zoom } = clientToScene(event.clientX, event.clientY);
      brushZoomRef.current = zoom;
      pending = {
        x: event.clientX - boardRect.left,
        y: event.clientY - boardRect.top,
        zoom,
      };
      if (!frame) frame = requestAnimationFrame(flush);
    };

    window.addEventListener("pointermove", positionBrush);
    window.addEventListener("pointerdown", positionBrush, true);
    apiRef.current?.setCursor?.(eraserCanvasCursorCss());

    return () => {
      window.removeEventListener("pointermove", positionBrush);
      window.removeEventListener("pointerdown", positionBrush, true);
      if (frame) cancelAnimationFrame(frame);
      hide();
    };
  }, [activeTool, clientToScene, interactive]);

  // Dragging the eraser-size slider must resize the ring without waiting for the
  // next pointer sample. This runs per slider step, not per move.
  useEffect(() => {
    if (activeTool !== "eraser") return;
    eraserBrushRef.current?.setDiameter(eraserScreenRadius(strokeWidth, brushZoomRef.current) * 2);
  }, [activeTool, strokeWidth]);

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
    const api = apiRef.current;
    if (!api) return;
    const appState = api.getAppState() as {
      selectedElementIds?: Record<string, boolean>;
      editingTextElement?: { id?: string; fontFamily?: number; lineHeight?: number } | null;
    };
    const selected = new Set(
      Object.entries(appState.selectedElementIds ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id),
    );
    const editingId = appState.editingTextElement?.id ?? editingTextIdRef.current;
    if (editingId) selected.add(editingId);

    const current = api.getSceneElements() as Array<{
      id: string;
      type: string;
      fontSize?: number;
      fontFamily?: number;
      lineHeight?: number;
      version?: number;
      versionNonce?: number;
      [key: string]: unknown;
    }>;
    let changed = false;
    let edited: (typeof current)[number] | null = null;
    const next = current.map((el) => {
      if (el.type !== "text" || !selected.has(el.id) || el.fontSize === size) return el;
      changed = true;
      const updated = {
        ...el,
        fontSize: size,
        version: (el.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      };
      if (el.id === editingId) edited = updated;
      return updated;
    });

    api.updateScene({
      appState: { currentItemFontSize: size },
      ...(changed ? { elements: next } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    // Live wysiwyg keeps its own <textarea> styles — push the size there too so
    // the caret stays put and the glyphs resize while still typing.
    if (editingId) {
      const editable = document.querySelector<HTMLTextAreaElement>(
        "textarea.excalidraw-wysiwyg",
      );
      if (editable) {
        const source =
          edited ??
          next.find((el) => el.id === editingId) ??
          appState.editingTextElement;
        editable.style.fontSize = `${size}px`;
        if (source?.lineHeight) {
          editable.style.lineHeight = String(source.lineHeight);
        }
        requestAnimationFrame(() => {
          editable.focus({ preventScroll: true });
        });
      }
    }
  }, []);

  const setInk = useCallback((color: string) => {
    setInkColor(color);
    persistInkPrefs({ inkColor: color });
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } });
  }, [persistInkPrefs]);

  useEffect(() => {
    const api = apiRef.current;
    const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
    const ink = resolveInkColor(themeId, inkPrefsRef.current.inkColor);
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
      const floor = mobile && fitZoomMinRef.current != null ? fitZoomMinRef.current : ZOOM_MIN;
      const clamped = clampZoom(next, floor);
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
      };
      const bounds = pageBoundsRef.current;
      let appState: Record<string, unknown> = { zoom: { value: clamped } };
      if (mobile && bounds && typeof state.width === "number" && typeof state.height === "number") {
        const inset = mobilePageInsets(toolbarHeightRef.current);
        const clampedScroll = clampScrollToBounds(
          state.scrollX ?? 0,
          state.scrollY ?? 0,
          clamped,
          state.width,
          state.height,
          bounds,
          inset,
        );
        appState = { ...appState, ...clampedScroll };
      }
      api.updateScene({
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setZoomPct(Math.round(clamped * 100));
      requestAnimationFrame(reportCodeSlot);
    },
    [mobile, reportCodeSlot],
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
          ".lc-code-dock, .lc-toolbar, .lc-map-controls, .lc-ink-chrome, .monaco-editor, textarea, input, [contenteditable='true']",
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
      const floor = mobile && fitZoomMinRef.current != null ? fitZoomMinRef.current : ZOOM_MIN;
      const nextZoom = clampZoom(next, floor);
      if (nextZoom === zoom) return;

      let appState = getStateForZoom(
        {
          viewportX: event.clientX,
          viewportY: event.clientY,
          nextZoom,
        },
        state,
      );
      const bounds = pageBoundsRef.current;
      const full = api.getAppState() as { width?: number; height?: number };
      if (
        mobile &&
        bounds &&
        typeof full.width === "number" &&
        typeof full.height === "number"
      ) {
        const inset = mobilePageInsets(toolbarHeightRef.current);
        const clampedScroll = clampScrollToBounds(
          appState.scrollX,
          appState.scrollY,
          nextZoom,
          full.width,
          full.height,
          bounds,
          inset,
        );
        appState = { ...appState, ...clampedScroll };
      }

      api.updateScene({
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setZoomPct(Math.round(nextZoom * 100));
      requestAnimationFrame(reportCodeSlot);
    };

    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [interactive, mobile, reportCodeSlot]);

  const fitView = useCallback((regionId?: string | null) => {
    const api = apiRef.current;
    if (!api) return;

    // One region / scratch page per fit so the dashed border can fill the chrome
    // hole. Desktop landing uses the problem statement alone (code stays below).
    const page = regionId ?? mobileRegionRef.current;
    const wanted: string[] = page ? [page] : ["constraints"];

    let live = api.getSceneElements() as LayoutElement[];
    let frames = regionFramesOf(live);
    let focusFrames = wanted
      .map((id) => frames.get(id as RegionId))
      .filter((frame): frame is LayoutElement => Boolean(frame));

    // Scratch pages use pad-* ids that aren't in REGIONS — find by lcRegion.
    if (focusFrames.length === 0 && page) {
      focusFrames = live.filter((element) => {
        const region = element.customData?.lcRegion;
        return (
          element.customData?.lcRegionFrame === true &&
          typeof region === "string" &&
          region === page
        );
      }) as LayoutElement[];
    }

    const inWanted = (element: LayoutElement) => {
      const region = element.customData?.lcRegion;
      return typeof region === "string" && wanted.includes(region);
    };

    const tagged = focusFrames.length > 0 ? focusFrames : live.filter(inWanted);

    const template = templateRef.current as LayoutElement[];
    const target =
      tagged.length > 0
        ? tagged
        : template.length > 0
          ? template.filter(inWanted)
          : live;

    let focus = target.length > 0 ? target : live;

    const state = api.getAppState() as {
      width?: number;
      height?: number;
    };
    const viewWidth = num(state.width, 0);
    const viewHeight = num(state.height, 0);
    if (viewWidth < 1 || viewHeight < 1) return;

    const safeTop = mobile ? 0 : safeCssPx("--lc-safe-top");
    const safeBottom = mobile ? 0 : safeCssPx("--lc-safe-bottom");
    const safeLeft = mobile ? 0 : safeCssPx("--lc-safe-left");
    const safeRight = mobile ? 0 : safeCssPx("--lc-safe-right");
    const measured = measureChromeInsets(
      boardRef.current,
      toolbarHeightRef.current,
      mapChromeHiddenRef.current,
      mobile,
    );
    const inset = {
      top: measured.top + safeTop,
      left: measured.left + safeLeft,
      right: measured.right + safeRight,
      bottom: measured.bottom + safeBottom,
    };
    const availWidth = Math.max(80, viewWidth - inset.left - inset.right);
    const availHeight = Math.max(80, viewHeight - inset.top - inset.bottom);

    /*
     * Size the focus frame so width-fill zoom also fills height — the dashed
     * border then touches the toolbar and the magnification row.
     */
    const primary =
      focus.find((element) => element.customData?.lcRegionFrame) ?? focus[0];
    if (primary && typeof primary.id === "string") {
      const regionKey = primary.customData?.lcRegion;
      const isScratch =
        typeof regionKey === "string" && regionKey.startsWith("pad-");
      const frameW = Math.max(
        1,
        num(primary.width, isScratch ? SCRATCH_PAGE_W : REGIONS.constraints.w),
      );
      const zoomForWidth = clampZoom(availWidth / frameW);
      const fillHeight = availHeight / Math.max(0.05, zoomForWidth);
      const regionMin =
        typeof regionKey === "string" && regionKey in REGION_MIN
          ? REGION_MIN[regionKey as RegionId].minH
          : 800;
      const nextH = Math.max(regionMin, Math.round(fillHeight));
      const curH = num(primary.height, 0);
      if (Math.abs(curH - nextH) > 2 || Math.abs(num(primary.width, 0) - frameW) > 2) {
        const nextElements = live.map((element) =>
          element.id === primary.id ? { ...element, height: nextH, width: frameW } : element,
        ) as LayoutElement[];
        const synced = isScratch
          ? nextElements
          : syncRegionLayout(nextElements, {
              codeContentHeight: codeContentHeightRef.current ?? undefined,
            }) ?? nextElements;
        layoutSyncingRef.current = true;
        api.updateScene({
          elements: synced as unknown[],
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        layoutSyncingRef.current = false;
        live = synced;
        frames = regionFramesOf(live);
        focusFrames = wanted
          .map((id) => frames.get(id as RegionId))
          .filter((frame): frame is LayoutElement => Boolean(frame));
        if (focusFrames.length === 0 && page) {
          focusFrames = live.filter((element) => {
            const region = element.customData?.lcRegion;
            return (
              element.customData?.lcRegionFrame === true &&
              typeof region === "string" &&
              region === page
            );
          }) as LayoutElement[];
        }
        focus =
          focusFrames.length > 0
            ? focusFrames
            : live.filter(inWanted).length > 0
              ? live.filter(inWanted)
              : live;
      }
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const element of focus) {
      if (typeof element.x !== "number" || typeof element.y !== "number") continue;
      minX = Math.min(minX, element.x);
      minY = Math.min(minY, element.y);
      maxX = Math.max(maxX, element.x + num(element.width, 0));
      maxY = Math.max(maxY, element.y + num(element.height, 0));
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

    const boxWidth = Math.max(1, maxX - minX);
    const boxHeight = Math.max(1, maxY - minY);
    // Exact fill of the chrome hole (both axes).
    const zoom = clampZoom(Math.min(availWidth / boxWidth, availHeight / boxHeight));
    fitZoomMinRef.current = zoom;
    setZoomFloorPct(Math.round(zoom * 100));
    pageBoundsRef.current = { minX, minY, maxX, maxY };

    const slackX = Math.max(0, availWidth - boxWidth * zoom);
    const slackY = Math.max(0, availHeight - boxHeight * zoom);
    api.updateScene({
      appState: {
        zoom: { value: zoom },
        scrollX: (inset.left + slackX / 2) / zoom - minX,
        scrollY: (inset.top + slackY / 2) / zoom - minY,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setZoomPct(Math.round(zoom * 100));
    requestAnimationFrame(reportCodeSlot);
    requestAnimationFrame(reportLinedSlot);
  }, [mobile, reportCodeSlot, reportLinedSlot]);

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

  useEffect(() => {
    reportLinedSlot();
  }, [linedPaper, reportLinedSlot]);

  /** Keep the template tucked under the toolbar when its strip grows or folds. */
  useEffect(() => {
    if (!mobile || !interactive || mobileRegionRef.current === null) return;
    const handle = window.setTimeout(() => fitView(), 80);
    return () => window.clearTimeout(handle);
  }, [toolbarHeight, mobile, interactive, fitView]);

  /** Chrome show/hide — repaint overlays only; preserve zoom and pan. */
  useEffect(() => {
    if (!interactive) return;
    requestAnimationFrame(() => {
      reportCodeSlot();
      reportLinedSlot();
    });
  }, [mapChromeHidden, interactive, reportCodeSlot, reportLinedSlot]);

  /** Fit the current page, or the landing pair on desktop. Event-handler safe. */
  const fitCurrentView = useCallback(() => {
    fitView();
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
    const sized = applyBoardReadingSize(recolored, readingSizeRef.current, {
      captureFrom: "M",
      lined: linedPaperRef.current,
    });
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
    const before = api.getSceneElements() as LayoutElement[];
    const synced = syncRegionLayout(before, {
      codeContentHeight: codeContentHeightRef.current ?? undefined,
    });
    if (!synced) return;

    // Frames may resize; they must not translate. If Excalidraw dragged one,
    // force the snap through IMMEDIATELY so the move does not linger on screen.
    let translated = false;
    for (const el of before) {
      if (el.type !== "rectangle" || !el.customData?.lcRegionFrame) continue;
      const next = synced.find((candidate) => candidate.id === el.id);
      if (next && (next.x !== el.x || next.y !== el.y)) {
        translated = true;
        break;
      }
    }

    layoutSyncingRef.current = true;
    api.updateScene({
      elements: synced,
      captureUpdate: translated
        ? CaptureUpdateAction.IMMEDIATELY
        : CaptureUpdateAction.NEVER,
    });
    requestAnimationFrame(() => {
      layoutSyncingRef.current = false;
    });
  }, []);

  /** Resolve once every seeded region frame is in the scene (and fonts are ready). */
  const waitForTemplate = useCallback((): Promise<void> => {
    const waitFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const fontsReady =
      typeof document !== "undefined" && "fonts" in document
        ? document.fonts.ready.then(() => undefined).catch(() => undefined)
        : Promise.resolve();

    return (async () => {
      await fontsReady;
      const neededRegions = new Set(
        Object.keys(REGIONS).map((id) => `lcregion-${id}-frame`),
      );
      for (let attempt = 0; attempt < 45; attempt++) {
        const scene = apiRef.current?.getSceneElements() ?? [];
        const ids = new Set(
          scene.map((el) => (el as { id?: string }).id ?? ""),
        );
        const hasScratch = scene.some((el) => {
          const meta = (el as { customData?: { lcScratchFrame?: boolean } }).customData;
          return Boolean(meta?.lcScratchFrame);
        });
        if (hasScratch) {
          await waitFrame();
          await waitFrame();
          return;
        }
        let ready = true;
        for (const id of neededRegions) {
          if (!ids.has(id)) {
            ready = false;
            break;
          }
        }
        if (ready) {
          applyRegionLayout();
          await waitFrame();
          await waitFrame();
          return;
        }
        await waitFrame();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      applyRegionLayout();
    })();
  }, [applyRegionLayout]);

  const fitCodeToSource = useCallback(
    (source: string) => {
      lastCodeSourceRef.current = source;
      codeContentHeightRef.current = codeFrameHeightForSource(source, readingSizeRef.current);
      applyRegionLayout();
      requestAnimationFrame(reportCodeSlot);
    },
    [applyRegionLayout, reportCodeSlot],
  );

  /** Apply S/M/L to statement body fonts and restack; chrome stays fixed. */
  const reflowReadingText = useCallback(
    (opts?: { size?: BoardReadingSize; captureFrom?: BoardReadingSize }) => {
      const api = apiRef.current;
      if (!api || layoutSyncingRef.current) return;
      const size = opts?.size ?? readingSizeRef.current;
      const current = api.getSceneElements() as SceneElementLike[];
      const scaled = applyBoardReadingSize(current, size, {
        captureFrom: opts?.captureFrom ?? size,
        lined: linedPaperRef.current,
      });
      if (scaled === current) return;
      layoutSyncingRef.current = true;
      api.updateScene({
        elements: scaled as unknown[],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      requestAnimationFrame(() => {
        layoutSyncingRef.current = false;
        applyRegionLayout();
        reportCodeSlot();
        reportLinedSlot();
      });
    },
    [applyRegionLayout, reportCodeSlot, reportLinedSlot],
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

      reflowReadingText({ size: next, captureFrom: prev });
      if (lastCodeSourceRef.current) {
        codeContentHeightRef.current = codeFrameHeightForSource(
          lastCodeSourceRef.current,
          next,
        );
      }
    },
    [onReadingSizeChange, reflowReadingText],
  );

  // Page turn: refit on the new region and re-report (or clear) the code slot.
  // Same settle pattern as problem load — Excalidraw needs a couple of frames
  // before scroll/zoom land where they were asked to.
  useEffect(() => {
    const next = mobileRegion ?? null;
    const previous = mobileRegionRef.current;
    mobileRegionRef.current = next;
    if (!interactive || previous === next) return;
    // Hide the other pages *before* fitting: a page is the only thing on the
    // canvas, so zooming out on a tablet shows one frame, not the whole column.
    syncPageVisibility();
    reportCodeSlot();
    void settleFitView().then(() => {
      reportCodeSlot();
    });
  }, [
    interactive,
    mobileRegion,
    reportCodeSlot,
    settleFitView,
    syncPageVisibility,
  ]);

  const handleSceneChange = useCallback(
    (
      _elements?: readonly unknown[],
      appState?: {
        editingTextElement?: { id?: string } | null;
        isResizing?: boolean;
        resizingElement?: { id?: string; type?: string } | null;
        newElement?: { type?: string } | null;
        selectedElementIds?: Record<string, boolean>;
      },
    ) => {
      const api = apiRef.current;
      if (!api) {
        onChange?.();
        return;
      }

      // Frames: pin column position, zero rotation; resize height/width still works.
      applyRegionLayout();
      reportCodeSlot();

      const editingId = appState?.editingTextElement?.id ?? null;
      const prevEditingId = editingTextIdRef.current;
      const resizing = Boolean(appState?.isResizing || appState?.resizingElement);
      const current = api.getSceneElements() as Array<{
        id: string;
        type: string;
        width?: number;
        height?: number;
        angle?: number;
        text?: string;
        originalText?: string;
        autoResize?: boolean;
        isDeleted?: boolean;
        customData?: { lcRegion?: string; lcVizId?: string; lcRegionFrame?: boolean } | null;
        [key: string]: unknown;
      }>;

      let changed = false;
      const next = current.map((el) => {
        if (el.isDeleted) return el;

        // Template boxes never rotate.
        if (el.customData?.lcRegionFrame && typeof el.angle === "number" && el.angle !== 0) {
          changed = true;
          return { ...el, angle: 0 };
        }

        if (el.type !== "text" || el.customData?.lcRegion || el.customData?.lcVizId) {
          return el;
        }

        const raw = (el.originalText ?? el.text ?? "").trim();

        // While the text tool is active, keep empty boxes so click-around can
        // open a new editor. Cull empties only after leaving the tool (setTool).
        if (el.id !== editingId && raw.length === 0 && activeTool !== "text") {
          changed = true;
          return { ...el, isDeleted: true };
        }

        // First place: wrap at a default width once editing ends. Forcing this
        // mid-edit fights Excalidraw's caret and blocks placing another box.
        if (el.id !== editingId && el.autoResize !== false) {
          changed = true;
          return {
            ...el,
            autoResize: false,
            width: TEXT_WRAP_WIDTH,
          };
        }

        if (
          resizing &&
          shiftHeldRef.current &&
          (appState?.resizingElement?.id === el.id ||
            appState?.selectedElementIds?.[el.id]) &&
          el.width !== TEXT_WRAP_WIDTH
        ) {
          changed = true;
          return { ...el, width: TEXT_WRAP_WIDTH };
        }

        return el;
      });

      if (changed) {
        layoutSyncingRef.current = true;
        api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(() => {
          layoutSyncingRef.current = false;
        });
      }

      // Text tool handoff:
      // - Enter (empty or not) → hand
      // - Typed text then click-away → hand
      // - Empty click-away → stay on text so another click can place quickly
      if (prevEditingId && !editingId && activeTool === "text") {
        const finished = current.find((el) => el.id === prevEditingId && !el.isDeleted);
        const finishedText = (finished?.originalText ?? finished?.text ?? "").trim();
        const viaEnter = textFinishedViaEnterRef.current;
        textFinishedViaEnterRef.current = false;
        if (viaEnter || finishedText.length > 0) {
          setTool("hand");
        } else {
          // Do NOT re-set the tool here. Clicking away from an empty box *is*
          // the click that places the next one, and re-entering the text tool
          // mid-gesture threw away the element Excalidraw had just started —
          // which is why placing used to cost two clicks. The tool is locked,
          // so it stays on text by itself; this only recovers the case where
          // Excalidraw dropped it, checked a frame later when the gesture is
          // over.
          window.requestAnimationFrame(() => {
            const state = apiRef.current?.getAppState() as
              | { activeTool?: { type?: string; locked?: boolean } }
              | undefined;
            if (state?.activeTool?.type === "text") return;
            apiRef.current?.setActiveTool({ type: "text", locked: true });
          });
        }
      }
      editingTextIdRef.current = editingId;

      // Anything drawn, pasted or restored since the last change joins the page
      // it landed on; everything else goes back under.
      syncPageVisibility();

      // Stamp trash: when a library stamp (or its group) is selected, float a
      // delete control at the selection's top-right.
      {
        const selectedIds = new Set(
          Object.entries(appState?.selectedElementIds ?? {})
            .filter(([, on]) => on)
            .map(([id]) => id),
        );
        if (selectedIds.size === 0) {
          setStampTrash((current) => (current ? null : current));
        } else {
          type StampEl = {
            id: string;
            x: number;
            y: number;
            width?: number;
            height?: number;
            isDeleted?: boolean;
            customData?: { lcStamp?: boolean; lcStampGroup?: string } | null;
          };
          const els = api.getSceneElements() as StampEl[];
          const selected = els.filter((el) => selectedIds.has(el.id) && !el.isDeleted);
          const stampSelected = selected.filter((el) => el.customData?.lcStamp);
          if (stampSelected.length === 0) {
            setStampTrash((current) => (current ? null : current));
          } else {
            const groupIds = new Set(
              stampSelected
                .map((el) => el.customData?.lcStampGroup)
                .filter((id): id is string => Boolean(id)),
            );
            const toDelete = els.filter((el) => {
              if (el.isDeleted || !el.customData?.lcStamp) return false;
              if (selectedIds.has(el.id)) return true;
              const g = el.customData.lcStampGroup;
              return Boolean(g && groupIds.has(g));
            });
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const el of toDelete) {
              const w = typeof el.width === "number" ? el.width : 0;
              const h = typeof el.height === "number" ? el.height : 0;
              minX = Math.min(minX, el.x);
              minY = Math.min(minY, el.y);
              maxX = Math.max(maxX, el.x + w);
              maxY = Math.max(maxY, el.y + h);
            }
            const state = api.getAppState() as {
              scrollX?: number;
              scrollY?: number;
              zoom?: { value?: number };
            };
            const zoom = state.zoom?.value ?? 1;
            const scrollX = state.scrollX ?? 0;
            const scrollY = state.scrollY ?? 0;
            const left = roundPx((maxX + scrollX) * zoom - 36);
            const top = roundPx((minY + scrollY) * zoom - 40);
            const ids = toDelete.map((el) => el.id);
            setStampTrash((current) => {
              if (
                current &&
                current.left === left &&
                current.top === top &&
                current.ids.length === ids.length &&
                current.ids.every((id, i) => id === ids[i])
              ) {
                return current;
              }
              return { left, top, ids };
            });
          }
        }
      }

      onChange?.();
    },
    [activeTool, applyRegionLayout, onChange, reportCodeSlot, setTool, syncPageVisibility],
  );

  useImperativeHandle(
    ref,
    (): BoardHandle => ({
      getElements: elements,
      // Callers hand back what `getElements` gave them — unpaged — so the open
      // page has to be re-applied on the way in.
      setElements: (next) => {
        const paged = applyPageVisibility(
          next as PageableElement[],
          mobileRegionRef.current,
        );
        apiRef.current?.updateScene({ elements: (paged ?? next) as unknown[] });
      },
      convert,
      seedTemplate: (skeletons: Skeleton[]) => {
        seedSkeletonsRef.current = skeletons;
        const dark = isDarkTheme(themeId);
        const converted = convert(skeletons, { regenerateIds: false }) as SceneElementLike[];
        const recolored = recolorTemplateElements(converted, dark) ?? converted;
        const next = applyBoardReadingSize(recolored, readingSizeRef.current, {
          captureFrom: "M",
          lined: linedPaperRef.current,
        });
        templateRef.current = next;
        rasterInkRef.current?.clear();
        apiRef.current?.updateScene({
          elements: next as unknown[],
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // Clear history after seeding so Ctrl+Z undoes student strokes, not the
        // empty board from before the problem loaded.
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          syncPageVisibility();
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
        // Downscaled inside captureImage — a full-size export of this board is
        // tens of megabytes, which is what the daemon refused to buffer.
        return captureImage(() => exportBoardBlob(api, rasterInkRef.current?.getOps() ?? []));
      },
      exportRegionThumbs: async () => {
        const api = apiRef.current;
        if (!api) return [];
        const all = api.getSceneElements() as SceneElementLike[];
        const ops = rasterInkRef.current?.getOps() ?? [];
        const thumbs: Array<{ region: RegionId; label: string; png: string }> = [];

        for (const region of STUDENT_REGION_ORDER) {
          if (region === "constraints" || region === "code") continue;
          const frame = all.find(
            (el) =>
              el.type === "rectangle" &&
              el.customData?.lcRegionFrame &&
              el.customData?.lcRegion === region,
          );
          if (!frame) continue;

          const inBox = all.filter((el) => {
            if (el.isDeleted) return false;
            if (el.customData?.lcVizId) return false;
            if (el.customData?.lcRegion === region) return true;
            if (!frame) return false;
            const cx = el.x + el.width / 2;
            const cy = el.y + el.height / 2;
            return (
              cx >= frame.x &&
              cy >= frame.y &&
              cx <= frame.x + frame.width &&
              cy <= frame.y + frame.height
            );
          });

          // Skip empty template chrome (frame + label + hint only).
          const authored = inBox.filter(
            (el) => !el.customData?.lcRegionFrame && !el.id.includes("-label") && !el.id.includes("-hint"),
          );
          const hasInk = ops.some((op) =>
            op.points.some(
              (pt) =>
                pt.x >= frame.x &&
                pt.y >= frame.y &&
                pt.x <= frame.x + frame.width &&
                pt.y <= frame.y + frame.height,
            ),
          );
          if (authored.length === 0 && !hasInk) continue;

          const png = await captureImage(
            () =>
              exportRegionBlob(
                api,
                ops,
                inBox as SceneElementLike[],
                {
                  x: frame.x,
                  y: frame.y,
                  width: frame.width,
                  height: frame.height,
                },
              ),
            { maxEdge: 640, maxBase64: 2 * 1024 * 1024 },
          );
          if (png) {
            thumbs.push({ region, label: REGIONS[region].label, png });
          }
        }

        // Region crops only (with ink). A full-board thumb was huge in chat and
        // duplicated whatever the student already attached as Approach/etc.
        return thumbs;
      },
      getStrokes: () => captureStrokes(elements()),
      getInkStrokes: () => inkStrokesFromOps(rasterInkRef.current?.getOps() ?? []),
      getInkOpCount: () => (rasterInkRef.current?.getOps() ?? []).length,
      setInkOps: (ops) => {
        rasterInkRef.current?.setOps(ops);
      },
      setTool,
      undo: () => {
        undoBoard();
      },
      scrollToContent: () => apiRef.current?.scrollToContent(),
      zoomIn,
      zoomOut,
      fitView: fitCurrentView,
      fitRegion: (regionId: RegionId | string) => fitView(regionId),
      appendScratchPage: (skeletons: Skeleton[]) => {
        const api = apiRef.current;
        if (!api || skeletons.length === 0) return 0;
        const dark = isDarkTheme(themeId);
        const converted = convert(skeletons, { regenerateIds: false }) as SceneElementLike[];
        const recolored = recolorTemplateElements(converted, dark) ?? converted;
        const sized = applyBoardReadingSize(recolored, readingSizeRef.current, {
          captureFrom: "M",
          lined: linedPaperRef.current,
        });
        let maxPage = -1;
        for (const el of sized) {
          const page = (el as { customData?: { lcScratchPage?: unknown } }).customData
            ?.lcScratchPage;
          if (typeof page === "number" && Number.isFinite(page)) {
            maxPage = Math.max(maxPage, Math.floor(page));
          }
        }
        const current = api.getSceneElements() as unknown[];
        api.updateScene({
          elements: [...current, ...(sized as unknown[])],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        templateRef.current = [
          ...(templateRef.current as SceneElementLike[]),
          ...(sized as SceneElementLike[]),
        ];
        requestAnimationFrame(() => {
          syncPageVisibility();
          scheduleFitView();
        });
        return Math.max(0, maxPage);
      },
      settleFitView,
      waitForTemplate,
      fitCodeToSource,
      hasRasterInk: () => rasterInkRef.current?.hasInk() ?? false,
      saveBoard: () => {
        const api = apiRef.current;
        const state = (api?.getAppState() ?? {}) as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
        };
        const kept = elements().filter((element) => !isCoachElement(element));
        const ink = rasterInkRef.current?.getOps() ?? [];
        return {
          v: 1 as const,
          elements: kept as unknown[],
          appState: {
            scrollX: state.scrollX ?? 0,
            scrollY: state.scrollY ?? 0,
            zoom: state.zoom?.value ?? 1,
          },
          ink,
        };
      },
      restoreBoard: (nextElements, appState, options) => {
        if (options?.skeletons?.length) {
          seedSkeletonsRef.current = options.skeletons;
        }
        // A board written on a tablet mid-page can only ever hold real values
        // (`getElements` unpages), but clear it anyway: an older file, or one
        // hand-edited, must not restore an invisible page.
        const cleared = clearPageVisibility(
          nextElements as PageableElement[],
        ) as unknown as SceneElementLike[];
        const scratchHealed = healScratchpadGeometry(cleared) as SceneElementLike[];
        const healed = healBoardLayout(scratchHealed, {
            readingSize: readingSizeRef.current,
            codeContentHeight: codeContentHeightRef.current ?? undefined,
          },
        );
        // Keep a fit target so landing zooms to problem+code, not the full board.
        templateRef.current = healed as unknown[];
        // Drop saved zoom/pan — never pass zoom: undefined (Excalidraw crashes).
        const saved = { ...((appState as Record<string, unknown> | undefined) ?? {}) };
        delete saved.zoom;
        delete saved.scrollX;
        delete saved.scrollY;
        apiRef.current?.updateScene({
          elements: healed,
          ...(Object.keys(saved).length > 0 ? { appState: saved } : {}),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        rasterInkRef.current?.setOps(options?.ink ?? []);
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          syncPageVisibility();
          scheduleFitView();
        });
      },
      applyThemeInk: (nextThemeId: string) => {
        const api = apiRef.current;
        if (!api) return;
        const dark = isDarkTheme(nextThemeId);
        const theme = BOARD_THEMES.find((candidate) => candidate.id === nextThemeId) ?? BOARD_THEMES[0];
        const ink = resolveInkColor(nextThemeId, inkPrefsRef.current.inkColor);
        setInkColor(ink);
        const scene = api.getSceneElements() as SceneElementLike[];
        const recolored = recolorTemplateElements(scene, dark);
        api.updateScene({
          appState: {
            viewBackgroundColor: theme.background,
            currentItemStrokeColor: ink,
          },
          ...(recolored
            ? { elements: recolored as unknown[], captureUpdate: CaptureUpdateAction.NEVER }
            : {}),
        });
      },
      stripCoachViz: () => {
        const api = apiRef.current;
        if (!api) return;
        const scene = api.getSceneElements() as SceneElementLike[];
        api.updateScene({
          elements: scene.filter((element) => !isCoachElement(element)) as unknown[],
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      },
    }),
    [convert, elements, fitCodeToSource, fitCurrentView, fitView, settleFitView, waitForTemplate, resetTemplate, scheduleFitView, setTool, syncPageVisibility, themeId, undoBoard, zoomIn, zoomOut],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  const initialData = useMemo(
    () => {
      const prefs = inkPrefsRef.current;
      return {
        appState: {
          viewBackgroundColor: theme.background,
          currentItemStrokeColor: resolveInkColor(themeId, prefs.inkColor),
          currentItemStrokeWidth: prefs.penWidth,
          currentItemRoughness: 1,
          // Not the hand-drawn default: typed notes should read like notes.
          currentItemFontFamily: FONT_UI,
          currentItemFontSize: DEFAULT_FONT_SIZE,
          // Prefer click-to-place text with a wrap width over drag-to-size.
          currentItemAutoResize: false,
        },
        // We call settleFitView ourselves — Excalidraw's default fits the entire
        // board and lands the problem as a postage stamp in the corner.
        scrollToContent: false,
      };
    },
    [theme.background, themeId],
  );

  return (
    <div
      ref={boardRef}
      className={interactive ? "lc-board" : "lc-board lc-board-idle"}
    >
      {linedPaper && linedSlot && linedSlot.width > 8 && linedSlot.height > 8 && (
        <div
          className="lc-board-lined-overlay"
          aria-hidden
          style={{
            left: linedSlot.left,
            top: linedSlot.top,
            width: linedSlot.width,
            height: linedSlot.height,
            backgroundSize: `100% ${linedSlot.gap}px`,
            backgroundPosition: `0 ${linedSlot.phase}px`,
          }}
        />
      )}
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
            mobile={mobile}
            onHeightChange={setToolbarHeight}
          />
          <div
            className={[
              bottomCenter ? "lc-map-controls lc-map-controls-paged" : "lc-map-controls",
              mapChromeHidden ? "lc-map-controls-collapsed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="lc-map-chrome-left">
              {!mapChromeHidden && onThemePick && (
                <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
              )}
            </div>
            {!mapChromeHidden && bottomCenter}
            <div className="lc-map-chrome-right">
              <div className="lc-map-chrome-row">
                <button
                  type="button"
                  className={
                    mapChromeHidden
                      ? "lc-map-btn lc-chrome-eye is-dimmed"
                      : "lc-map-btn lc-chrome-eye"
                  }
                  aria-pressed={!mapChromeHidden}
                  aria-label={mapChromeHidden ? "Show board chrome" : "Hide board chrome"}
                  title={mapChromeHidden ? "Show controls" : "Hide controls"}
                  onClick={() => setMapChromeHidden((current) => !current)}
                >
                  <EyeIcon closed={mapChromeHidden} />
                </button>
                {!mapChromeHidden && linedPaperToggle && (
                  <button
                    type="button"
                    className={
                      linedPaper ? "lc-lined-toggle is-active" : "lc-lined-toggle"
                    }
                    aria-pressed={linedPaper}
                    aria-label="Lined paper"
                    title="Lined paper"
                    onClick={() => {
                      const next = !linedPaperRef.current;
                      linedPaperRef.current = next;
                      setLinedPaper(next);
                      reflowReadingText();
                      requestAnimationFrame(reportLinedSlot);
                    }}
                  >
                    <span aria-hidden>🗒️</span>
                  </button>
                )}
              </div>
              {!mapChromeHidden && showReadingSize && (
                <ReadingSizeControl value={readingSize} onChange={setReadingSize} />
              )}
              {!mapChromeHidden && (
                <ZoomControls
                  zoomPct={zoomPct}
                  zoomFloorPct={zoomFloorPct}
                  zoomMaxPct={Math.round(ZOOM_MAX * 100)}
                  onZoomIn={zoomIn}
                  onZoomOut={zoomOut}
                  onFit={fitCurrentView}
                />
              )}
            </div>
            {coachFold}
          </div>
        </>
      )}
      {interactive && activeTool === "eraser" && <EraserBrush ref={eraserBrushRef} />}
      <RasterInkLayer
        ref={rasterInkRef}
        enabled={interactive}
        tool={
          interactive && inkToolActive
            ? activeTool === "eraser"
              ? "eraser"
              : "pen"
            : null
        }
        strokeWidth={strokeWidth}
        inkColor={inkColor}
        pressureSensitive={pressureSensitive}
        getViewport={getViewport}
        clip={inkClip}
        onChange={onChange}
        onStrokeMove={interactive ? onInkStrokeMove : undefined}
        onStrokeEnd={interactive ? onInkStrokeEnd : undefined}
        onStylusAccessory={interactive ? handleStylusAccessory : undefined}
      />
      <Excalidraw
        viewModeEnabled={!interactive}
        handleKeyboardGlobally={interactive}
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExcalidrawApi;
          scrollUnsubRef.current?.();
          scrollUnsubRef.current =
            apiRef.current.onScrollChange?.((scrollX, scrollY, zoom) => {
              const pct = Math.round(zoom.value * 100);
              setZoomPct((current) => (current === pct ? current : pct));
              rasterInkRef.current?.repaint();
              reportCodeSlot();
              reportLinedSlot();

              if (!mobile || clampingScrollRef.current) return;
              const bounds = pageBoundsRef.current;
              const api = apiRef.current;
              if (!bounds || !api) return;
              const state = api.getAppState() as { width?: number; height?: number };
              if (typeof state.width !== "number" || typeof state.height !== "number") return;
              const inset = mobilePageInsets(toolbarHeightRef.current);
              const next = clampScrollToBounds(
                scrollX,
                scrollY,
                zoom.value,
                state.width,
                state.height,
                bounds,
                inset,
              );
              if (
                Math.abs(next.scrollX - scrollX) < 0.05 &&
                Math.abs(next.scrollY - scrollY) < 0.05
              ) {
                return;
              }
              clampingScrollRef.current = true;
              api.updateScene({
                appState: next,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
              requestAnimationFrame(() => {
                clampingScrollRef.current = false;
              });
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
      {interactive && inkChrome && (() => {
          const toEraser = activeTool !== "eraser";
          const phaseClass =
            inkChrome.phase === "in"
              ? "lc-ink-chrome-in"
              : inkChrome.phase === "out"
                ? "lc-ink-chrome-out"
                : "";
          return (
            <div
              className={["lc-ink-chrome", phaseClass].filter(Boolean).join(" ")}
              style={{ left: inkChrome.left, top: inkChrome.top }}
              onPointerDown={(event) => event.stopPropagation()}
              onAnimationEnd={() => {
                if (inkChrome.phase === "in") {
                  setInkChrome((current) =>
                    current && current.phase === "in" ? { ...current, phase: "shown" } : current,
                  );
                }
              }}
            >
              <button
                type="button"
                className="lc-ink-chrome-btn"
                aria-label={toEraser ? "Switch to eraser" : "Switch to pen"}
                onClick={() => {
                  if (shapesOpen) setShapesOpen(false);
                  setTool(toEraser ? "eraser" : "freedraw");
                }}
              >
                {toEraser ? <PinkEraserIcon /> : <PenIcon />}
              </button>
              <button
                type="button"
                className="lc-ink-chrome-btn"
                aria-label="Undo"
                onClick={() => undoBoard()}
              >
                <UndoIcon />
              </button>
              <button
                type="button"
                className="lc-ink-chrome-btn"
                aria-label="Redo"
                onClick={() => redoBoard()}
              >
                <RedoIcon />
              </button>
              <div
                className="lc-ink-chrome-dial-wrap"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <InkChromeSizeDial
                  value={strokeWidth}
                  onChange={setStrokeWidth}
                  label={activeTool === "eraser" ? "Eraser size" : "Stroke weight"}
                  eraser={activeTool === "eraser"}
                />
              </div>
            </div>
          );
        })()}
      {interactive && stampTrash && (
        <button
          type="button"
          className="lc-stamp-trash"
          style={{ left: stampTrash.left, top: stampTrash.top }}
          aria-label="Delete stamp"
          title="Delete stamp"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => deleteSelectedStamps()}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
      )}
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
  onClear: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Tablet / phone layout — horizontal strip with a fold control. */
  mobile?: boolean;
  /** Reports strip height so fitView can place the template under it. */
  onHeightChange?: (height: number) => void;
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
  onClear,
  onReset,
  onUndo,
  onRedo,
  mobile = false,
  onHeightChange,
}: ToolbarProps) {
  const showInk =
    active === "freedraw" ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "text";
  // Stroke weight is for pen / shapes / eraser — not the text tool (that has its own slider).
  const showStrokeSizes =
    active === "freedraw" ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "eraser";
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  /** Reset asks first, in our own modal — never a browser confirm box. */
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [folded, setFolded] = useState(mobile);
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = toolbarRootRef.current;
    if (!node || !onHeightChange) return;
    const publish = () => onHeightChange(Math.ceil(node.getBoundingClientRect().height));
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onHeightChange, folded, shapesOpen]);

  useEffect(() => {
    if (!shapesOpen) {
      setConfiguring(null);
      setMods({});
      setShapePhase("list");
    }
  }, [shapesOpen]);

  const pickShape = (shape: ShapeStamp) => {
    setConfiguring(shape);
    setMods({ ...shape.defaults });
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const backToList = () => {
    setShapePhase("list");
    setConfiguring(null);
    setMods({});
  };

  const placeConfigured = () => {
    if (configuring) {
      onStamp(configuring, mods, moveAsOne);
    }
    backToList();
  };

  const modifierTitle = configuring?.label ?? "";

  const pickTool = (tool: ToolName) => {
    if (shapesOpen) onToggleShapes();
    onPick(tool);
  };

  const renderToolButton = (tool: ToolName, label: string, hint: string, emoji?: string) => (
    <button
      key={tool}
      type="button"
      className={tool === active && !shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
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
  );

  const activeToolMeta = TOOLS.find((entry) => entry.tool === active);

  const toolExtras = (
    <>
      {showInk && (
        <>
          <div className="lc-tool-sep" />
          <div className="lc-tool-group lc-ink-colors" role="group" aria-label="Ink colour">
            {inkSwatches(themeId).map((color) => (
              <button
                key={color}
                type="button"
                className={
                  color === inkColor ? "lc-ink-swatch lc-ink-swatch-active" : "lc-ink-swatch"
                }
                style={{ background: color }}
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
              eraser={active === "eraser"}
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
        <>
          <div className="lc-tool-sep" />
          <div className="lc-stroke-controls">
            <FontSizeSlider value={fontSize} onChange={onFontSize} />
          </div>
        </>
      )}

      <button type="button" className="lc-tool lc-tool-labeled" aria-label="Undo" onClick={onUndo}>
        <UndoIcon />
        <span className="lc-tool-caption">Undo</span>
      </button>
      <button type="button" className="lc-tool lc-tool-labeled" aria-label="Redo" onClick={onRedo}>
        <RedoIcon />
        <span className="lc-tool-caption">Redo</span>
      </button>

      <button
        type="button"
        className="lc-tool lc-tool-danger lc-tool-labeled"
        aria-label="Clear your work"
        onClick={onClear}
      >
        <ClearIcon />
        <span className="lc-tool-caption">Clear</span>
      </button>
      <button
        type="button"
        className="lc-tool lc-tool-labeled"
        aria-label="Reset board"
        onClick={() => setConfirmingReset(true)}
      >
        <ResetIcon />
        <span className="lc-tool-caption">Reset</span>
      </button>
    </>
  );

  const shapesButton = (
    <button
      type="button"
      className={shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
      aria-label="Shapes"
      aria-expanded={shapesOpen}
      onClick={onToggleShapes}
    >
      ⬡
    </button>
  );

  return (
    <div
      ref={toolbarRootRef}
      className={[
        "lc-toolbar",
        mobile ? "lc-toolbar-mobile" : "",
        mobile && folded ? "lc-toolbar-folded" : "",
        shapesOpen ? "lc-toolbar-shapes-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="toolbar"
      aria-label="Drawing tools"
    >
      {mobile && (
        <button
          type="button"
          className="lc-tool lc-tool-fold"
          aria-label={folded ? "Show tools" : "Fold tools"}
          aria-expanded={!folded}
          onClick={() => {
            setFolded((wasFolded) => {
              if (!wasFolded && shapesOpen) onToggleShapes();
              return !wasFolded;
            });
          }}
        >
          {folded ? "▸" : "▾"}
        </button>
      )}

      {/* Folded mobile: only the active tool stays visible next to the chevron. */}
      {mobile && folded && activeToolMeta &&
        renderToolButton(
          activeToolMeta.tool,
          activeToolMeta.label,
          activeToolMeta.hint,
          activeToolMeta.emoji,
        )}

      {mobile ? (
        <div className="lc-toolbar-expandable">
          {TOOLS.map(({ tool, label, hint, emoji }) =>
            renderToolButton(tool, label, hint, emoji),
          )}
          {shapesButton}
          {toolExtras}
        </div>
      ) : (
        <>
          {TOOLS.map(({ tool, label, hint, emoji }) =>
            renderToolButton(tool, label, hint, emoji),
          )}
          {shapesButton}
          {toolExtras}
        </>
      )}

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
                const items = SHAPES.filter((shape) => shape.group === group);
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
            </>
          )}

          {shapePhase === "mod" && configuring && (

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

      <div className="lc-tool-sep lc-desktop-only" />

      {!mobile && (
      <button
        type="button"
        className={helpOpen ? "lc-tool lc-tool-active" : "lc-tool"}
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        aria-expanded={helpOpen}
        onClick={() => setHelpOpen((open) => !open)}
      >
        ?
      </button>
      )}

      {!mobile && helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

      {confirmingReset && (
        <ConfirmDialog
          title="Reset the board?"
          message="The board goes back to the original problem layout. Everything you drew, typed, or stamped on the canvas is cleared."
          detail="Your solution code and the coach thread are not touched."
          confirmLabel="Reset board"
          cancelLabel="Keep my work"
          onConfirm={() => {
            setConfirmingReset(false);
            onReset();
          }}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </div>
  );
}

/**
 * What the keyboard actually does on this board.
 *
 * Excalidraw's own single-key shortcuts are suppressed by the key guard in
 * `Board`, because they belong to a UI this app hides: pressing `s` or `g` on a
 * selected shape used to open a colour palette nobody asked for, and `1`–`9`
 * silently swapped tools out from under the pen. What is left is this list, and
 * this button is where you can read it.
 */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="lc-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <header className="lc-shortcuts-head">
        <strong>Keyboard</strong>
        <button type="button" className="lc-link" onClick={onClose}>
          close
        </button>
      </header>
      <dl className="lc-shortcuts-list">
        {BOARD_SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="lc-shortcut">
            <dt>{keys}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="lc-muted lc-shortcuts-note">
        Tools are the strip on the left — no single-key shortcuts, so nothing changes under
        your pen by accident.
      </p>
    </div>
  );
}

const BOARD_SHORTCUTS: Array<[string, string]> = [
  ["Ctrl / ⌘ + Z", "Undo"],
  ["Ctrl / ⌘ + Shift + Z", "Redo"],
  ["Scroll", "Zoom toward the pointer"],
  ["Shift + scroll", "Pan sideways"],
  ["Space + drag", "Pan"],
  ["Delete / Backspace", "Delete the selection"],
  ["Escape", "Deselect / close a popover"],
  ["Enter", "Finish a text box (Shift + Enter for a new line)"],
  ["Arrow keys", "Nudge the selection"],
];

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

function PenIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.5 4.5 19.5 9.5 9 20H4v-5Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="m12.5 6.5 5 5"
      />
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

function EyeIcon({ closed = false }: { closed?: boolean }) {
  if (closed) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
        <path d="M1 1l22 22" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ZoomControls({
  zoomPct,
  zoomFloorPct,
  zoomMaxPct,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoomPct: number;
  zoomFloorPct: number;
  zoomMaxPct: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const atMin = zoomPct <= zoomFloorPct;
  const atMax = zoomPct >= zoomMaxPct;
  return (
    <div className="lc-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="lc-map-btn"
        data-tip={atMax ? `Maximum zoom (${zoomMaxPct}%)` : "Zoom in"}
        data-tip-placement="left"
        aria-label={atMax ? `Zoom in disabled, maximum ${zoomMaxPct}%` : "Zoom in"}
        disabled={atMax}
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip={atMin ? `Minimum zoom (${zoomFloorPct}%)` : "Zoom out"}
        data-tip-placement="left"
        aria-label={atMin ? `Zoom out disabled, minimum ${zoomFloorPct}%` : "Zoom out"}
        disabled={atMin}
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip={`Fit width (${zoomPct}%)`}
        data-tip-placement="left"
        aria-label={`Fit width, ${zoomPct}% zoom`}
        onClick={onFit}
      >
        ⊡
      </button>
    </div>
  );
}