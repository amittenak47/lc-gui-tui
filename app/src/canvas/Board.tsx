/**
 * The Excalidraw canvas, wrapped so nothing above it depends on Excalidraw.
 *
 * `@excalidraw/excalidraw` is a plain React component — only excalidraw.com's
 * wrapper is Electron — so it mounts straight into the Tauri WebView.
 *
 * Excalidraw's own chrome is hidden (see `.lc-board` in styles.css) and replaced
 * by {@link BoardToolbar} — one floating island at the bottom of the canvas
 * holding the tools, shapes, undo/redo, reset and the ink colour. A stylus
 * session should never need a menu.
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  resolveShapeMods,
  DEFAULT_SHAPE_PALETTE,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import { healBoardLayout } from "./healBoardLayout";
import {
  healScratchpadGeometry,
  parseScratchPageId,
  scratchTitleAnchor,
  SCRATCH_PAGE_W,
} from "../templates/scratchpad";
import { regionFrameId, regionFramesOf, syncRegionLayout, type LayoutElement } from "../templates/regionLayout";
import { recolorTemplateElements } from "../templates/problemBoard";
import { codeFrameHeightForSource, codeLabelReserve } from "../util/solutionPad";
import { REGION_GUTTER, REGION_MIN, REGIONS, STUDENT_REGION_ORDER, type RegionId } from "../templates/regions";
import {
  BOARD_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_CODE,
  FONT_UI,
  type Skeleton,
} from "../templates/skeleton";
import { BackgroundPalette } from "../components/BackgroundPalette";
import { resolveInkColor } from "./inkColors";
import { useIsMobile } from "../util/mobile";
import { isDarkTheme } from "../theme/appThemes";
import {
  statementLinePitch,
  type BoardReadingSize,
} from "../modes/codeFontSize";
import { applyBoardReadingSize } from "../modes/applyBoardReadingSize";
import { textBaselineY, SCRATCH_LINE_PITCH, linedRuleClearance, defaultLineHeight } from "../modes/textBaseline";
import type { BoardBinaryFile, BoardHandle, ScreenRect, ToolName } from "./BoardHandle";
import { captureImage, captureStrokes, type SceneElementLike } from "./capture";
import { TEXT_FONT_MAX, TEXT_FONT_MIN } from "./FontSizeSlider";
import { applyMetadata, isCoachElement } from "./scene";
import {
  applyPageVisibility,
  clearPageVisibility,
  pageBounds,
  type PageableElement,
} from "./pageView";
import { eraserScreenRadius } from "./rasterInk";
import { EraserBrush, type EraserBrushHandle } from "./EraserBrush";
import { ZoomIndicator, type ZoomIndicatorHandle } from "./ZoomIndicator";
import { TextPlaceGhost, type TextPlaceGhostHandle } from "./TextPlaceGhost";
import {
  minTextBox,
  textClientFromScene,
  textEditorAnchor,
  textPlaceRect,
  TEXT_TAP_SLOP_PX,
  type TextPlaceViewport,
} from "./textPlacement";
import { RasterInkLayer, type RasterInkHandle } from "./RasterInkLayer";
import { BoardToolbar } from "./BoardToolbar";
import { loadInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadInkPressureClip } from "../util/inkPressureClip";
import { loadInkSmoothing, loadInkSmoothingMode } from "../util/inkSmoothingPref";
import { loadInkSpeed } from "../util/inkSpeedPref";
import {
  describeCaptureResult,
  loadAutoSaveCaptures,
  loadCaptureCountdown,
  saveCaptureToDevice,
} from "../util/capturePrefs";
import { CaptureFeedback, type CaptureFeedbackHandle } from "./CaptureFeedback";
import { loadInkToolPrefs, saveInkToolPrefs } from "../util/inkToolPrefs";
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
  addFiles?(files: Array<{
    id: string;
    mimeType: string;
    dataURL: string;
    created: number;
  }>): void;
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

/**
 * Capture an arbitrary scene rectangle (board screenshot of a region), including
 * raster ink. Works even when the rect contains only ink / empty background.
 */
async function exportSceneFrameBlob(
  api: ExcalidrawApi,
  ops: readonly InkOp[],
  frame: { x: number; y: number; width: number; height: number },
): Promise<Blob> {
  const appState = api.getAppState();
  const files = api.getFiles();
  const all = api.getSceneElements() as SceneElementLike[];
  const background =
    (appState as { viewBackgroundColor?: string }).viewBackgroundColor ?? "#fff";
  const bounds: SceneBounds = {
    minX: frame.x,
    minY: frame.y,
    maxX: frame.x + frame.width,
    maxY: frame.y + frame.height,
  };
  const drawScale = clampExportScale(2, bounds);
  const width = Math.max(1, Math.round(frame.width * drawScale));
  const height = Math.max(1, Math.round(frame.height * drawScale));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) {
    return new Blob([], { type: "image/png" });
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  if (all.length > 0) {
    const board = await exportToCanvas({
      elements: all as never,
      appState: {
        ...(appState as object),
        exportBackground: true,
        viewBackgroundColor: background,
      } as never,
      files: files as never,
      exportPadding: 0,
    });
    const [minX, minY, maxX, maxY] = getCommonBounds(all as never);
    const boardBounds: SceneBounds = { minX, minY, maxX, maxY };
    const boardScale = exportScaleFrom(board.width, board.height, boardBounds);
    if (boardScale !== null) {
      ctx.drawImage(
        board,
        (frame.x - minX) * boardScale,
        (frame.y - minY) * boardScale,
        frame.width * boardScale,
        frame.height * boardScale,
        0,
        0,
        width,
        height,
      );
    }
  }

  const regionOps = ops.filter((op) =>
    op.points.some(
      (pt) =>
        pt.x >= bounds.minX &&
        pt.y >= bounds.minY &&
        pt.x <= bounds.maxX &&
        pt.y <= bounds.maxY,
    ),
  );
  if (regionOps.length > 0) {
    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = width;
    inkCanvas.height = height;
    const inkCtx = inkCanvas.getContext("2d");
    if (inkCtx) {
      paintInkAtScale(inkCtx, regionOps, { x: bounds.minX, y: bounds.minY }, drawScale);
      ctx.drawImage(inkCanvas, 0, 0);
    }
  }

  const composited = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, "image/png", 0.85),
  );
  return composited ?? new Blob([], { type: "image/png" });
}

function newImageFileId(): string {
  return `lcimg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function loadImageSize(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: Math.max(1, img.naturalWidth || img.width),
        height: Math.max(1, img.naturalHeight || img.height),
      });
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataURL;
  });
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 1.75;
const ZOOM_STEP = 1.15;
/** Button zoom animation — retargets smoothly on repeat / hold. */
const ZOOM_ANIM_MS = 220;
/** Hand-tool pan inertia — exponential friction per ms (same feel as NumberWheel). */
const PAN_FRICTION = 0.0038;
/** Minimum scroll speed (scene units/ms) to coast after a flick. */
const PAN_FLICK_MIN = 0.06;
/** Stop coasting below this scroll speed. */
const PAN_REST_SPEED = 0.00025;

function zoomEaseOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

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

/**
 * Viewport chrome around the fitted template page.
 *
 * Bottom tray / toolbar overlay the canvas — they do not shrink the board
 * element. The template page frame includes the toolbar strip; chrome draws on
 * top. Eye-hide only conceals menu items (toolbar height stays reserved in the
 * overlay), so fit insets stay small either way.
 */
function mobilePageInsets(
  _toolbarH: number,
  _chromeHidden: boolean,
): {
  top: number;
  left: number;
  right: number;
  bottom: number;
} {
  return {
    top: 6,
    left: 2,
    right: 2,
    // Template includes the bottom chrome strip; toolbar floats over it.
    bottom: 12,
  };
}

/** Desktop page fit — full board including the toolbar overlay zone. */
function desktopPageInsets(
  _toolbarH: number,
  _chromeHidden: boolean,
): {
  top: number;
  left: number;
  right: number;
  bottom: number;
} {
  return {
    top: 8,
    left: 4,
    right: 4,
    bottom: 12,
  };
}

/**
 * Measure the live chrome hole. Template includes the toolbar overlay area —
 * stop just above the very bottom edge, not above the floating controls.
 *
 * Insets are authored constants — do not call `getBoundingClientRect` here. A
 * scroll clamp runs every wheel/pan frame, and re-learning a box only a resize
 * can move was the forced-layout tax the camera perf pass removed.
 */
function measureChromeInsets(
  _boardEl: HTMLElement | null,
  toolbarH: number,
  chromeHidden: boolean,
  mobile: boolean,
): { top: number; left: number; right: number; bottom: number } {
  return mobile
    ? mobilePageInsets(toolbarH, chromeHidden)
    : desktopPageInsets(toolbarH, chromeHidden);
}

/**
 * Keep the viewport inside the open template page.
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
  // Use a looser epsilon so a width-fitted page does not allow one-sided drift
  // from float error / gutter padding.
  if (contentW <= visW + 1) {
    nextX = inset.left / zoom - bounds.minX + (visW - contentW) / 2;
  } else {
    const maxX = inset.left / zoom - bounds.minX;
    const minX = (viewWidth - inset.right) / zoom - bounds.maxX;
    // Guard against inverted ranges (bad bounds) — never allow min > max.
    const lo = Math.min(minX, maxX);
    const hi = Math.max(minX, maxX);
    nextX = Math.min(hi, Math.max(lo, scrollX));
  }
  if (contentH <= visH + 1) {
    nextY = inset.top / zoom - bounds.minY + (visH - contentH) / 2;
  } else {
    const maxY = inset.top / zoom - bounds.minY;
    const minY = (viewHeight - inset.bottom) / zoom - bounds.maxY;
    const lo = Math.min(minY, maxY);
    const hi = Math.max(minY, maxY);
    nextY = Math.min(hi, Math.max(lo, scrollY));
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
  /** Shared reading size for problem statement + code (locked to Medium). */
  readingSize?: BoardReadingSize;
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
  /**
   * Chrome pinned to the open page's title line — the scratchpad pager. It
   * rides the page through the camera, so it stays part of the paper instead of
   * squatting in the bottom bar next to the tools.
   */
  pageTitle?: ReactNode;
  /**
   * HTML laid onto the open page, under the canvas — the Markdown Ink document.
   *
   * Rides the camera in scene space: the board lays it out at the page's scene
   * width and scales the whole thing by the zoom, so anything drawn over it
   * stays on the words it was drawn on. It never takes a pointer, so the pen
   * and the hand both reach the canvas through it.
   */
  pageContent?: ReactNode;
  /**
   * Scene height the page frame should grow to — the measured document.
   *
   * A prop rather than a handle call because the imperative version had to
   * land *after* the template existed, and a call that arrives one frame early
   * silently does nothing: the frame stays at its floor, the pan clamp stays
   * with it, and the reader can scroll to the bottom of a page that ends long
   * before the text does. As a prop it is re-applied whenever either side
   * changes, so there is no ordering left to get wrong.
   */
  pageContentHeight?: number | null;
  /**
   * Let {@link pageContent} show through the canvas.
   *
   * Excalidraw paints an opaque viewport background, which would bury the
   * markdown underneath it completely — the document layer is below the canvas
   * so that shapes and text draw *over* the words, and that only works if the
   * canvas has nothing of its own to draw first. The board's own surface colour
   * comes from the wrapper instead, so the page still reads as paper.
   */
  transparentCanvas?: boolean;
  /**
   * Offer the toolbar toggle in the map chrome.
   *
   * Toolbar on: drawing tools mount. Toolbar off: tools deselect and the board
   * is scroll-only (internal hand — never shown in the UI).
   */
  annotateToggle?: boolean;
  /** Annotation mode changed — the caller makes the dock stop taking pointers. */
  onAnnotateCodeChange?: (on: boolean) => void;
  /** Show lined-paper toggle in the map chrome. */
  linedPaperToggle?: boolean;
  /** Optional fold handle under the bottom chrome (coach closed → open). */
  coachFold?: ReactNode;
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
    mobileRegion = null,
    bottomCenter = null,
    pageTitle = null,
    pageContent = null,
    pageContentHeight = null,
    transparentCanvas = false,
    annotateToggle = true,
    onAnnotateCodeChange,
    linedPaperToggle = false,
    coachFold = null,
  },
  ref,
) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const [activeTool, setActiveTool] = useState<ToolName>("hand");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  /** Plain prose vs monospace “code note” for the Text tool. */
  const [textMode, setTextMode] = useState<"plain" | "code">("plain");
  const textModeRef = useRef(textMode);
  textModeRef.current = textMode;
  const inkPrefsRef = useRef(loadInkToolPrefs());
  const [inkColor, setInkColor] = useState(() =>
    resolveInkColor(themeId, inkPrefsRef.current.inkColor),
  );
  const inkColorRef = useRef(inkColor);
  inkColorRef.current = inkColor;
  const [penStrokeWidth, setPenStrokeWidth] = useState(() => inkPrefsRef.current.penWidth);
  const [eraserStrokeWidth, setEraserStrokeWidth] = useState(() => inkPrefsRef.current.eraserWidth);
  const [inkFullness, setInkFullnessState] = useState(() => inkPrefsRef.current.inkFullness);
  const strokeWidth = activeTool === "eraser" ? eraserStrokeWidth : penStrokeWidth;
  const [inkHandedness, setInkHandedness] = useState<InkHandedness>(() => loadInkHandedness());
  const [pressureClip, setPressureClip] = useState(() => loadInkPressureClip());
  const [inkSmoothing, setInkSmoothing] = useState(() => loadInkSmoothing());
  const [inkSmoothingMode, setInkSmoothingMode] = useState(() => loadInkSmoothingMode());
  const [inkSpeed, setInkSpeed] = useState(() => loadInkSpeed());
  const [stampTrash, setStampTrash] = useState<{
    left: number;
    top: number;
    ids: string[];
  } | null>(null);
  /**
   * Markdown content slot — width is React state (rare); left/top/zoom are
   * written to the DOM node so a scroll frame does not re-render Board.
   * Same class of fix as the zoom pill (camera perf pass).
   */
  const contentSlotNodeRef = useRef<HTMLDivElement | null>(null);
  const [contentSceneWidth, setContentSceneWidth] = useState(1);
  const lastContentSlotRef = useRef<{
    left: number;
    top: number;
    sceneWidth: number;
    zoom: number;
  } | null>(null);
  const pageContentRef = useRef<ReactNode>(pageContent);
  pageContentRef.current = pageContent;
  /**
   * This page is a document: fit its width and scroll the rest.
   *
   * The content slot is only ever a document, so its presence is the signal —
   * there is no second flag to keep in step with it.
   */

  const transparentCanvasRef = useRef(transparentCanvas);
  transparentCanvasRef.current = transparentCanvas;
  /** Reading mode: wheel scrolls, drags stay in the column. */
  /*
   * Column lock is always on. There is no free 2D pan on these pages — wheel
   * scrolls vertically, and a drag cannot wander sideways off the column.
   */
  const [scrollMode] = useState(true);
  const scrollModeRef = useRef(scrollMode);
  scrollModeRef.current = scrollMode;
  /**
   * Horizontal scroll the current drag is pinned to.
   *
   * Excalidraw's hand tool owns the drag and pans in two dimensions, so the
   * column is held by putting `scrollX` back rather than by stopping it moving.
   * Captured at pointerdown: a reader who has panned sideways to see a wide
   * code block should stay where they put themselves, not be snapped to a
   * margin the moment they scroll down.
   */
  const lockedScrollXRef = useRef<number | null>(null);
  /** Pen goes to the code page instead of the editor. */
  const [annotateCode, setAnnotateCode] = useState(false);
  const annotateCodeRef = useRef(annotateCode);
  annotateCodeRef.current = annotateCode;
  const [linedPaper, setLinedPaper] = useState(false);
  const linedPaperRef = useRef(linedPaper);
  linedPaperRef.current = linedPaper;
  /** Lined overlay — geometry written to the node; mount flag only. */
  const linedSlotNodeRef = useRef<HTMLDivElement | null>(null);
  const [linedSlotOn, setLinedSlotOn] = useState(false);
  const lastLinedSlotRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
    gap: number;
    phase: number;
  } | null>(null);
  const [titleSlot, setTitleSlot] = useState<{
    left: number;
    top: number;
    fontPx: number;
  } | null>(null);
  const titleSlotNodeRef = useRef<HTMLDivElement | null>(null);
  const lastTitleSlotRef = useRef<{ left: number; top: number; fontPx: number } | null>(null);
  const [mapChromeHidden, setMapChromeHidden] = useState(false);
  const mapChromeHiddenRef = useRef(mapChromeHidden);
  mapChromeHiddenRef.current = mapChromeHidden;
  const [pressureSensitive, setPressureSensitiveState] = useState(
    () => inkPrefsRef.current.pressureSensitive,
  );
  const eraserBrushRef = useRef<EraserBrushHandle | null>(null);
  const zoomIndicatorRef = useRef<ZoomIndicatorHandle | null>(null);
  /**
   * Settle the toolbar's copy of the zoom well after the pill has it.
   *
   * The pill is written every frame because it is one text node; `zoomPct` is
   * React state that re-renders Board and its toolbar, and doing *that* per
   * frame was a real part of why holding a zoom button stuttered. The number
   * only has to be right once the gesture stops.
   */
  const zoomPctSettleRef = useRef<number>(0);
  /** Last level the pill was raised for, so panning cannot keep it awake. */
  const lastZoomPctRef = useRef<number>(100);
  const textPlaceGhostRef = useRef<TextPlaceGhostHandle | null>(null);
  const captureFeedbackRef = useRef<CaptureFeedbackHandle | null>(null);
  const rasterInkRef = useRef<RasterInkHandle>(null);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [captureMenuOpen, setCaptureMenuOpen] = useState(false);
  const [captureRegion, setCaptureRegion] = useState<{
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const captureDragRef = useRef<{
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [captureArmed, setCaptureArmed] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [, setZoomPct] = useState(100);
  /** Effective zoom-out floor as a percent — page fit on mobile, else ZOOM_MIN. */
  const [, setZoomFloorPct] = useState(() => Math.round(ZOOM_MIN * 100));
  /** Scene box of the open mobile page — clips the raster ink layer to it. */
  const [inkClip, setInkClip] = useState<SceneBounds | null>(null);
  /** Floor zoom for the open mobile page (fit-to-chrome); null on desktop. */
  const fitZoomMinRef = useRef<number | null>(null);
  /** Live page bounds for scroll clamping (same box as inkClip). */
  const pageBoundsRef = useRef<SceneBounds | null>(null);
  /** Student changed zoom/pan — skip auto camera reset on resize refits. */
  const userAdjustedCameraRef = useRef(false);
  const zoomAnimRef = useRef<{
    from: number;
    to: number;
    start: number;
    rafId: number | null;
  } | null>(null);
  /** True while fitCamera is applying zoom/scroll (not user input). */
  const fittingCameraRef = useRef(false);
  /** Measured toolbar height so fitView lands the template under it. */
  /**
   * Height of the floating tool island, for the page inset.
   *
   * Deliberately a ref and not state: the island changes height when the active
   * tool shows or hides its size wheel, and routing that through React used to
   * re-render the board and fire a refit, which threw away whatever zoom the
   * user had set. Picking up the pen is not a request to reframe the page.
   */
  const toolbarHeightRef = useRef(36);
  const clampingScrollRef = useRef(false);
  /** Hand-tool pan: track velocity from scroll deltas for flick inertia. */
  const handPanningRef = useRef(false);
  const panVelocityRef = useRef({ x: 0, y: 0 });
  const lastPanScrollRef = useRef({ x: 0, y: 0, t: 0 });
  const inertiaFrameRef = useRef(0);
  const slotReportFrameRef = useRef(0);
  /**
   * Wheel / scroll bursts must pin ink tiles the same way a pan does.
   * Without this, every scroll frame paid full raster budget (camera perf).
   */
  const cameraMotionTimerRef = useRef(0);
  const cameraMotionActiveRef = useRef(false);
  const pulseCameraMotion = useCallback(() => {
    if (!cameraMotionActiveRef.current) {
      cameraMotionActiveRef.current = true;
      rasterInkRef.current?.setCameraMoving(true);
    }
    if (cameraMotionTimerRef.current) window.clearTimeout(cameraMotionTimerRef.current);
    cameraMotionTimerRef.current = window.setTimeout(() => {
      cameraMotionTimerRef.current = 0;
      cameraMotionActiveRef.current = false;
      rasterInkRef.current?.setCameraMoving(false);
    }, 140);
  }, []);
  const pulseCameraMotionRef = useRef(pulseCameraMotion);
  pulseCameraMotionRef.current = pulseCameraMotion;
  const readingSize = readingSizeProp ?? "M";
  const readingSizeRef = useRef(readingSize);
  readingSizeRef.current = readingSize;
  const templateRef = useRef<unknown[]>([]);
  const seedSkeletonsRef = useRef<Skeleton[]>([]);
  const scrollUnsubRef = useRef<(() => void) | null>(null);
  const layoutSyncingRef = useRef(false);
  const codeContentHeightRef = useRef<number | null>(null);
  const lastCodeSourceRef = useRef<string>("");
  const lastCodeSlotRef = useRef<ScreenRect | null>(null);
  /** Skip full scene reconcile when Excalidraw only moved the camera. */
  const lastSceneElementsRevRef = useRef<number>(-1);
  const lastSelectionSigRef = useRef<string>("");
  const lastElementsArgRef = useRef<readonly unknown[] | null>(null);
  const onCodeSlotRef = useRef(onCodeSlot);
  onCodeSlotRef.current = onCodeSlot;
  /** Read by `fitView` and `reportCodeSlot`, which must not re-bind per page. */
  const mobileRegionRef = useRef<string | null>(mobileRegion ?? null);
  // Keep in sync during render so seed/restore → settleFitView sees the page
  // before the page-turn effect runs (otherwise fit zooms to every scratch page).
  mobileRegionRef.current = mobileRegion ?? null;
  const prevMobileRegionRef = useRef<string | null>(mobileRegion ?? null);
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
    // Pan clamp uses the tight frame (no gutter pad) so a fitted page cannot
    // drift off one edge. Ink clip keeps the half-gutter pad.
    if (bounds) {
      const pad = REGION_GUTTER / 2;
      pageBoundsRef.current = {
        minX: bounds.minX + pad,
        minY: bounds.minY + pad,
        maxX: bounds.maxX - pad,
        maxY: bounds.maxY - pad,
      };
    } else {
      pageBoundsRef.current = null;
    }
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
    const rawLeft = (frame.x + scrollX) * zoom + inset;
    const rawTop = (frame.y + scrollY) * zoom + inset + headerReserve;
    const rawWidth = Math.max(0, num(frame.width, REGIONS.code.w) * zoom - inset * 2);
    const rawHeight = Math.max(
      0,
      num(frame.height, REGIONS.code.h) * zoom - inset * 2 - headerReserve,
    );

    /*
     * On the code page the dock is bounded by the screen, not by the frame.
     *
     * Zoom already reaches Monaco as a font size, and word wrap is on, so
     * zooming in *should* mean bigger code re-flowed to the same column with
     * the overflow under Monaco's own scrollbar. It did not, because the dock
     * was sized from the scene rect: the box grew with the zoom too, so the
     * text re-wrapped to a column that was now wider than the viewport and the
     * rest of it sat off the right-hand edge — unreachable, because a page
     * that is one HTML editor has nothing for the hand tool to pan.
     *
     * Clamping the box to the visible area fixes both halves at once. The
     * column stays the width of the screen however far in the zoom goes, the
     * text re-wraps into it, and what does not fit vertically is a scroll
     * rather than a pan.
     */
    const onCodePage = page === "code";
    const viewWidth = typeof state.width === "number" ? state.width : 0;
    const viewHeight = typeof state.height === "number" ? state.height : 0;
    const margin = Math.max(8, inset);
    const clampedLeft = onCodePage ? Math.max(margin, rawLeft) : rawLeft;
    const clampedTop = onCodePage ? Math.max(margin, rawTop) : rawTop;
    const next: ScreenRect = {
      left: roundPx(clampedLeft),
      top: roundPx(clampedTop),
      width: roundPx(
        onCodePage && viewWidth > 0
          ? Math.max(0, Math.min(rawWidth, viewWidth - clampedLeft - margin))
          : rawWidth,
      ),
      /*
       * Width is bounded by the screen; height is not.
       *
       * Clamping the height was what left Monaco with its own scrollbar, and an
       * editor that scrolls internally slides the code out from under ink that
       * does not move with it. The dock is now as tall as the page frame, which
       * is as tall as the code, so there is nothing left for Monaco to scroll —
       * the board scrolls instead, carrying text and marks on one transform.
       */
      height: roundPx(rawHeight),
      /*
       * On the code page, zoom is reported *relative to the page fit*.
       *
       * Monaco multiplies its base font by this. Absolute board zoom made that
       * base meaningless: the code region is a wide scene rect, so fitting it
       * to a tablet lands at a fraction of 1 and the editor rendered at a
       * fraction of its readable size — the "desktop view squeezed onto a
       * phone" problem. Measured against the fit instead, the page opens at the
       * reading size the S/M/L preference actually names, and zooming from
       * there scales it the way it reads: 2× really is twice the type.
       */
      zoom: Math.round(
        (onCodePage && (fitZoomMinRef.current ?? 0) > 0
          ? zoom / (fitZoomMinRef.current as number)
          : zoom) * 1000,
      ) / 1000,
    };

    // Hide the dock when the code frame is fully off-screen — switching to the
    // fallback absolute slot caused a visible snap while panning past the box.
    const viewH = viewHeight;
    const viewW = viewWidth;
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
  /** Project the open scratch page's title line to screen for the pager overlay. */
  const reportTitleSlot = useCallback(() => {
    const api = apiRef.current;
    const page = mobileRegionRef.current;
    const index = parseScratchPageId(page);
    const clear = () => {
      if (lastTitleSlotRef.current !== null) {
        lastTitleSlotRef.current = null;
        setTitleSlot(null);
      }
    };
    if (!api || index == null) {
      clear();
      return;
    }
    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
    };
    const zoom = state.zoom?.value ?? 1;
    const anchor = scratchTitleAnchor(index);
    // Rides the page, but never shrinks below a pressable size: a scratch page
    // fits the viewport at ~0.2 zoom, where authored 20px chrome is 4px tall.
    const next = {
      left: roundPx((anchor.x + (state.scrollX ?? 0)) * zoom),
      top: roundPx((anchor.y + (state.scrollY ?? 0)) * zoom),
      fontPx: Math.max(12, Math.round(20 * zoom)),
    };
    const prev = lastTitleSlotRef.current;
    if (prev && prev.left === next.left && prev.top === next.top && prev.fontPx === next.fontPx) {
      return;
    }
    lastTitleSlotRef.current = next;
    if (!prev) setTitleSlot(next);
    const node = titleSlotNodeRef.current;
    if (node) {
      node.style.left = `${next.left}px`;
      node.style.top = `${next.top}px`;
      node.style.fontSize = `${next.fontPx}px`;
    }
  }, []);

  /**
   * Project the open page onto the screen for the HTML content layer.
   *
   * Left/top/zoom go straight to the DOM node — a scroll frame must not
   * re-render Board (camera perf: same reason the zoom pill is imperative).
   * Scene width still uses React because it reflows the markdown column.
   */
  const reportContentSlot = useCallback(() => {
    const api = apiRef.current;
    const bounds = pageBoundsRef.current;
    const node = contentSlotNodeRef.current;
    if (!pageContentRef.current || !api || !bounds) {
      lastContentSlotRef.current = null;
      return;
    }
    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
    };
    const zoom = state.zoom?.value ?? 1;
    const next = {
      left: (bounds.minX + (state.scrollX ?? 0)) * zoom,
      top: (bounds.minY + (state.scrollY ?? 0)) * zoom,
      sceneWidth: Math.max(1, bounds.maxX - bounds.minX),
      zoom,
    };
    const last = lastContentSlotRef.current;
    if (
      last &&
      Math.abs(last.left - next.left) < 0.01 &&
      Math.abs(last.top - next.top) < 0.01 &&
      Math.abs(last.sceneWidth - next.sceneWidth) < 0.01 &&
      Math.abs(last.zoom - next.zoom) < 1e-4
    ) {
      return;
    }
    lastContentSlotRef.current = next;
    if (node) {
      node.style.left = `${next.left}px`;
      node.style.top = `${next.top}px`;
      node.style.transform = `scale(${next.zoom})`;
    }
    if (!last || Math.abs(last.sceneWidth - next.sceneWidth) >= 0.01) {
      setContentSceneWidth(next.sceneWidth);
    }
  }, []);

  /*
   * Toolbar owns annotate mode. Off → deselect tools and scroll-only hand.
   * On → Select is the entry tool (Hand is gone from the strip).
   */
  useEffect(() => {
    if (!annotateToggle && annotateCode) setAnnotateCode(false);
  }, [annotateCode, annotateToggle]);

  useEffect(() => {
    onAnnotateCodeChange?.(annotateCode);
  }, [annotateCode, onAnnotateCodeChange]);

  const reportLinedSlot = useCallback(() => {
    /*
     * The code page is not paper.
     *
     * Ruling it lines up nothing: Monaco sits in that frame with its own line
     * grid at its own pitch, so the board's rules run behind the editor at a
     * spacing that agrees with neither the code nor the statement, and the two
     * grids beat against each other. There is also nothing to write between
     * them — the page is for typing, not for handwriting.
     */
    if (mobileRegionRef.current === "code") {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlotOn(false);
      }
      return;
    }
    if (!linedPaperRef.current) {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlotOn(false);
      }
      return;
    }
    const api = apiRef.current;
    const bounds = pageBoundsRef.current;
    if (!api || !bounds) {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlotOn(false);
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
    // Scratchpad has no reading-size control — keep the authored grid.
    const page = mobileRegionRef.current;
    const isScratch = typeof page === "string" && page.startsWith("pad-");
    const pitchScene = isScratch
      ? SCRATCH_LINE_PITCH
      : statementLinePitch(readingSizeRef.current);
    // Scene pitch straight through the camera, sub-pixel and unclamped: a
    // floor here (there used to be one at 12px) means the rules stop shrinking
    // while the ink keeps going, so writing drifts off them as you zoom out.
    const gap = Math.max(1, Math.round(pitchScene * zoom * 100) / 100);

    let phase = 0;
    const elements = api.getSceneElements() as Array<{
      id?: string;
      type?: string;
      y?: number;
      fontSize?: number;
      lineHeight?: number;
      fontFamily?: number;
      customData?: { lcLineHeightBase?: number; lcFontBase?: number } | null;
    }>;
    const body = elements.find(
      (el) => el.type === "text" && typeof el.id === "string" && el.id.includes("-body-"),
    );
    // Prefer title/hint over PAGE label so large chrome sets the grid.
    const scratchAnchor =
      elements.find(
        (el) => el.type === "text" && typeof el.id === "string" && el.id.includes("-title"),
      ) ??
      elements.find(
        (el) => el.type === "text" && typeof el.id === "string" && el.id.includes("-hint"),
      ) ??
      elements.find(
        (el) =>
          el.type === "text" &&
          typeof el.id === "string" &&
          el.id.startsWith("lcscratch-"),
      );
    const anchor = body ?? scratchAnchor;
    if (anchor && typeof anchor.y === "number") {
      const baselineScene = textBaselineY({ ...anchor, y: anchor.y });
      if (baselineScene != null) {
        const fontSize =
          typeof anchor.fontSize === "number" && anchor.fontSize > 0
            ? anchor.fontSize
            : 28;
        // Rule sits just under the glyphs — not through the baseline.
        const ruleScene = baselineScene + linedRuleClearance(fontSize);
        const rulePx = (ruleScene + scrollY) * zoom;
        const rel = rulePx - top;
        // Gradient paints the rule at the end of each gap tile.
        phase = ((rel - gap + 1) % gap + gap) % gap;
      }
    } else if (isScratch) {
      // No chrome text — still lock rules to the authored pitch from the frame top.
      const firstRulePx = (bounds.minY + SCRATCH_LINE_PITCH + scrollY) * zoom;
      const rel = firstRulePx - top;
      phase = ((rel - gap + 1) % gap + gap) % gap;
    }

    const next = {
      left,
      top,
      width,
      height,
      gap,
      // Same sub-pixel precision as the gap, or the phase walks off the rules.
      phase: Math.round(phase * 100) / 100,
    };
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
    if (width > 8 && height > 8) {
      setLinedSlotOn((on) => on || true);
      const node = linedSlotNodeRef.current;
      if (node) {
        node.style.left = `${next.left}px`;
        node.style.top = `${next.top}px`;
        node.style.width = `${next.width}px`;
        node.style.height = `${next.height}px`;
        node.style.backgroundSize = `100% ${next.gap}px`;
        node.style.backgroundPosition = `0 ${next.phase}px`;
      }
    } else {
      setLinedSlotOn((on) => (on ? false : on));
    }
  }, []);

  const scheduleSlotReports = useCallback(() => {
    if (slotReportFrameRef.current) return;
    slotReportFrameRef.current = requestAnimationFrame(() => {
      slotReportFrameRef.current = 0;
      // Code dock only exists on the code page — skip the scene walk elsewhere.
      const page = mobileRegionRef.current;
      if (page === null || page === "code") reportCodeSlot();
      reportLinedSlot();
      reportTitleSlot();
      reportContentSlot();
    });
  }, [reportCodeSlot, reportContentSlot, reportLinedSlot, reportTitleSlot]);

  const clampPanScroll = useCallback((scrollX: number, scrollY: number, zoom: number) => {
    if (!mobileRef.current || mobileRegionRef.current == null) {
      return { scrollX, scrollY };
    }
    const bounds = pageBoundsRef.current;
    const api = apiRef.current;
    if (!bounds || !api) return { scrollX, scrollY };
    const state = api.getAppState() as { width?: number; height?: number };
    if (typeof state.width !== "number" || typeof state.height !== "number") {
      return { scrollX, scrollY };
    }
    const inset = measureChromeInsets(
      boardRef.current,
      toolbarHeightRef.current,
      mapChromeHiddenRef.current,
      mobileRef.current,
    );
    return clampScrollToBounds(
      scrollX,
      scrollY,
      zoom,
      state.width,
      state.height,
      bounds,
      inset,
    );
  }, []);

  const stopPanInertia = useCallback(() => {
    if (inertiaFrameRef.current) {
      cancelAnimationFrame(inertiaFrameRef.current);
      inertiaFrameRef.current = 0;
    }
  }, []);

  const persistInkPrefs = useCallback(
    (patch: Partial<{
      penWidth: number;
      eraserWidth: number;
      inkFullness: number;
      pressureSensitive: boolean;
      inkColor: string;
    }>) => {
      const next = {
        penWidth: patch.penWidth ?? penStrokeWidth,
        eraserWidth: patch.eraserWidth ?? eraserStrokeWidth,
        inkFullness: patch.inkFullness ?? inkFullness,
        pressureSensitive: patch.pressureSensitive ?? pressureSensitive,
        inkColor: patch.inkColor ?? inkColor,
      };
      inkPrefsRef.current = next;
      saveInkToolPrefs(next);
    },
    [penStrokeWidth, eraserStrokeWidth, inkFullness, pressureSensitive, inkColor],
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

  const setInkFullness = useCallback(
    (fullness: number) => {
      setInkFullnessState(fullness);
      persistInkPrefs({ inkFullness: fullness });
    },
    [persistInkPrefs],
  );

  const applyTextModeToAppState = useCallback((mode: "plain" | "code") => {
    apiRef.current?.updateScene({
      appState: {
        currentItemFontFamily: mode === "code" ? FONT_CODE : FONT_UI,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  const setTool = useCallback((tool: ToolName) => {
    if (tool === "freedraw") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcInk", locked: false });
      apiRef.current?.resetCursor?.();
    } else if (tool === "eraser") {
      apiRef.current?.setActiveTool({ type: "custom", customType: "lcEraser", locked: false });
      apiRef.current?.setCursor?.(eraserCanvasCursorCss());
    } else if (tool === "text") {
      // Excalidraw stays on `selection` while our Text tool is up. Its own text
      // tool cannot place a second box without a spare tap, and its
      // double-click — the only way to open the editor on a box we placed —
      // refuses to run under any other tool. The placement effect owns the
      // gesture; upstream only ever sees the hand-off.
      const zoom =
        (apiRef.current?.getAppState() as { zoom?: { value?: number } } | undefined)?.zoom
          ?.value ?? 1;
      const size = Math.min(
        TEXT_FONT_MAX,
        Math.max(TEXT_FONT_MIN, Math.round(DEFAULT_FONT_SIZE / Math.max(zoom, 0.35))),
      );
      setFontSizeState(size);
      apiRef.current?.updateScene({
        appState: {
          currentItemFontSize: size,
          currentItemAutoResize: true,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      apiRef.current?.setActiveTool({ type: "selection" });
      apiRef.current?.setCursor?.("text");
      applyTextModeToAppState(textModeRef.current);
    } else {
      apiRef.current?.setActiveTool({ type: tool, locked: false });
      apiRef.current?.resetCursor?.();
    }
    // The brush node unmounts with the tool; hiding it here keeps a stale ring
    // off the canvas for the frame between the click and the unmount.
    if (tool !== "eraser") eraserBrushRef.current?.setVisible(false);
    if (tool !== "text") textPlaceGhostRef.current?.setVisible(false);

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
    // Scroll tool: drop any selection. A selected page frame draws animated
    // ants around the whole document and tanks scroll on long pages.
    if (tool === "hand") {
      apiRef.current?.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [activeTool, applyTextModeToAppState]);

  useEffect(() => {
    if (annotateCode) {
      setShapesOpen(false);
      setCaptureMenuOpen(false);
      setTool("selection");
      return;
    }
    setShapesOpen(false);
    setCaptureMenuOpen(false);
    setTool("hand");
    apiRef.current?.updateScene({
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // Only when the toolbar mode flips — setTool changes every tool pick and
    // must not yank the pen back to Select mid-stroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotateCode]);

  const pickTextMode = useCallback(
    (mode: "plain" | "code") => {
      setTextMode(mode);
      textModeRef.current = mode;
      applyTextModeToAppState(mode);
      setTool("text");
    },
    [applyTextModeToAppState, setTool],
  );

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
      return true;
    },
    [setTool, shapesOpen],
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

  useEffect(() => {
    const onClip = () => setPressureClip(loadInkPressureClip());
    window.addEventListener("lc-ink-pressure-clip", onClip);
    return () => window.removeEventListener("lc-ink-pressure-clip", onClip);
  }, []);

  useEffect(() => {
    const onSmoothing = () => {
      setInkSmoothing(loadInkSmoothing());
      setInkSmoothingMode(loadInkSmoothingMode());
    };
    window.addEventListener("lc-ink-smoothing", onSmoothing);
    return () => window.removeEventListener("lc-ink-smoothing", onSmoothing);
  }, []);

  useEffect(() => {
    const onSpeed = () => setInkSpeed(loadInkSpeed());
    window.addEventListener("lc-ink-speed", onSpeed);
    return () => window.removeEventListener("lc-ink-speed", onSpeed);
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

  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    /*
     * Nothing pans any more.
     *
     * Every page is laid out at a size the reading control names and fills the
     * width of the screen, so there is no ground beside the page to reach — a
     * drag could only push the content off-centre and leave you fighting the
     * clamp to get it back. Up and down is the only direction that means
     * anything on these pages, and that is a scroll.
     *
     * Kept as a named predicate rather than deleting the pointer path: the
     * flick, its velocity estimate and the inertia all hang off it, and this is
     * the one place that decides whether any of that runs.
     */
    const isHandPanTarget = (_target: EventTarget | null) => false;

    const startPanInertia = (velocityX: number, velocityY: number) => {
      const api = apiRef.current;
      if (!api) return;
      stopPanInertia();
      let velX = velocityX;
      let velY = velocityY;
      let last = performance.now();
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        zoom?: { value?: number };
      };
      let scrollX = state.scrollX ?? 0;
      let scrollY = state.scrollY ?? 0;
      const zoom = state.zoom?.value ?? 1;

      const settle = () => {
        inertiaFrameRef.current = 0;
        api.updateScene({
          appState: { scrollX, scrollY },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        rasterInkRef.current?.setCameraMoving(false);
        scheduleSlotReports();
      };

      const step = (now: number) => {
        const dt = Math.min(34, Math.max(1, now - last));
        last = now;
        const wantX = scrollX + velX * dt;
        const wantY = scrollY + velY * dt;
        const clamped = clampPanScroll(wantX, wantY, zoom);
        /*
         * An axis that would not go where the coast asked is done coasting.
         *
         * This used to keep integrating velocity into a wall: every frame the
         * coast asked for ground the clamp refuses, the clamp answered with the
         * edge — or, on an axis whose content fits the viewport, with the
         * centred position, which is not the edge but the middle. So the flick
         * threw the view out and the clamp yanked it back, once per frame, for
         * as long as the friction took to die. That is the bounce, and on a
         * fitted axis it is also why a flick looked like it reverted: it was
         * being re-centred sixty times a second.
         *
         * Stopping the axis at the boundary is the whole fix. It also ends the
         * coast honestly — a flick into a wall should stop at the wall, not
         * spend a second pretending it is still moving.
         */
        /*
         * Land soft: keep the fraction of the step the clamp actually allowed.
         *
         * Zeroing velocity the moment the clamp bit stopped the coast dead —
         * correct, in that it no longer fought the wall, but it arrived at the
         * boundary at full speed and halted in one frame, which reads as
         * bouncing off it. Scaling by how much of the requested step got taken
         * decays the velocity over the last few frames instead: far from the
         * edge the ratio is 1 and nothing changes, and as the wall comes up
         * each frame gets less of what it asked for, so the view glides into
         * the boundary and settles there.
         */
        const takenX = clamped.scrollX - scrollX;
        const takenY = clamped.scrollY - scrollY;
        const wantedX = wantX - scrollX;
        const wantedY = wantY - scrollY;
        if (Math.abs(wantedX) > 1e-6) {
          velX *= Math.min(1, Math.max(0, takenX / wantedX));
        }
        if (Math.abs(wantedY) > 1e-6) {
          velY *= Math.min(1, Math.max(0, takenY / wantedY));
        }
        scrollX = clamped.scrollX;
        scrollY = clamped.scrollY;
        velX *= Math.exp(-PAN_FRICTION * dt);
        velY *= Math.exp(-PAN_FRICTION * dt);
        if (Math.abs(velX) < PAN_REST_SPEED && Math.abs(velY) < PAN_REST_SPEED) {
          settle();
          return;
        }
        api.updateScene({
          appState: { scrollX, scrollY },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        rasterInkRef.current?.syncCamera();
        scheduleSlotReports();
        inertiaFrameRef.current = requestAnimationFrame(step);
      };
      rasterInkRef.current?.setCameraMoving(true);
      inertiaFrameRef.current = requestAnimationFrame(step);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (activeToolRef.current !== "hand") return;
      if (event.button !== 0) return;
      if (!isHandPanTarget(event.target)) return;
      stopPanInertia();
      handPanningRef.current = true;
      rasterInkRef.current?.setCameraMoving(true);
      lockedScrollXRef.current = null;
      panVelocityRef.current = { x: 0, y: 0 };
      const api = apiRef.current;
      const now = performance.now();
      if (api) {
        const state = api.getAppState() as { scrollX?: number; scrollY?: number };
        lastPanScrollRef.current = {
          x: state.scrollX ?? 0,
          y: state.scrollY ?? 0,
          t: now,
        };
        if (scrollModeRef.current) lockedScrollXRef.current = state.scrollX ?? 0;
      } else {
        lastPanScrollRef.current = { x: 0, y: 0, t: now };
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!handPanningRef.current) return;
      handPanningRef.current = false;
      if (activeToolRef.current !== "hand") {
        rasterInkRef.current?.setCameraMoving(false);
        return;
      }
      if (!isHandPanTarget(event.target)) {
        rasterInkRef.current?.setCameraMoving(false);
        return;
      }
      const raw = scrollModeRef.current
        ? { x: 0, y: panVelocityRef.current.y }
        : panVelocityRef.current;
      /*
       * Drop the components that have nowhere to go.
       *
       * Pressed against a boundary, the clamp already refuses that axis, so
       * coasting into it can only produce a frame of motion the clamp undoes —
       * which is the judder this is meant to be rid of. A throw along the wall
       * still coasts; a throw into it simply does not start.
       */
      const vel = (() => {
        const api = apiRef.current;
        if (!api) return raw;
        const state = api.getAppState() as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
        };
        const x = state.scrollX ?? 0;
        const y = state.scrollY ?? 0;
        const probe = clampPanScroll(x + raw.x * 16, y + raw.y * 16, state.zoom?.value ?? 1);
        return {
          x: Math.abs(probe.scrollX - x) < 0.5 ? 0 : raw.x,
          y: Math.abs(probe.scrollY - y) < 0.5 ? 0 : raw.y,
        };
      })();
      const speed = Math.hypot(vel.x, vel.y);
      // The lift is not the settle when the view is still coasting — leave the
      // level pinned and let the coast's own settle release it.
      if (speed >= PAN_FLICK_MIN) {
        startPanInertia(vel.x, vel.y);
        return;
      }
      rasterInkRef.current?.setCameraMoving(false);
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointerup", onPointerUp, true);
    root.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointerup", onPointerUp, true);
      root.removeEventListener("pointercancel", onPointerUp, true);
      stopPanInertia();
    };
  }, [clampPanScroll, interactive, scheduleSlotReports, stopPanInertia]);

  useEffect(() => {
    stopPanInertia();
    handPanningRef.current = false;
    rasterInkRef.current?.setCameraMoving(false);
  }, [activeTool, stopPanInertia]);

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
    let pending: { clientX: number; clientY: number } | null = null;
    let visible = false;

    // Everything that reads the DOM lives in here, not in the move handler.
    // Hit-testing the pointer against the canvas box used to cost two
    // `getBoundingClientRect()` calls per sample — a forced layout of the whole
    // board on every event, ahead of the rAF that was supposed to be batching
    // the work. Once a frame is as often as the answer can change, and inside
    // rAF the reads come before this function's own style writes, so they are
    // measuring a layout nobody has dirtied.
    const flush = () => {
      frame = 0;
      const next = pending;
      pending = null;
      const brush = eraserBrushRef.current;
      if (!brush || !next) return;
      const hitCanvas =
        root.querySelector("canvas.lc-raster-ink") ??
        root.querySelector("canvas.excalidraw__canvas");
      if (!(hitCanvas instanceof HTMLCanvasElement)) return;
      const rect = hitCanvas.getBoundingClientRect();
      if (
        next.clientX < rect.left ||
        next.clientX > rect.right ||
        next.clientY < rect.top ||
        next.clientY > rect.bottom
      ) {
        hide();
        return;
      }
      const boardRect = root.getBoundingClientRect();
      const { zoom } = clientToScene(next.clientX, next.clientY);
      brushZoomRef.current = zoom;
      brush.setDiameter(eraserScreenRadius(strokeWidthRef.current, zoom) * 2);
      brush.move(next.clientX - boardRect.left, next.clientY - boardRect.top);
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
      pending = { clientX: event.clientX, clientY: event.clientY };
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

  /**
   * Text placement — our gesture, Excalidraw's editor.
   *
   * Two upstream rules fight a locked text tool on a tablet.
   * `handleTextOnPointerDown` returns early while `editingTextElement` is set,
   * so every box after the first costs two taps: one to commit, one to place.
   * And `handleCanvasDoubleClick` — the one entry point that will open the
   * wysiwyg on an element we placed ourselves — bails unless the active tool is
   * `selection`. Dispatching a double-click while Excalidraw sat on the text
   * tool was therefore a no-op: the box appeared, the editor never did, and the
   * soft keyboard never came up.
   *
   * So Excalidraw stays on `selection` for as long as our Text tool is up, we
   * own the pointer gesture, insert the element, select it, then hand over with
   * a double-click inside it. Upstream sees a selected text element, treats it
   * as existing, and opens and focuses its textarea. That focus lands inside
   * the pointerup's user-activation window, which is what makes Android raise
   * the keyboard.
   *
   * Nothing here replays pointer events. The previous attempt did, and
   * `handleCanvasPointerDown` calls `setPointerCapture` with the id it is
   * given — a synthetic id belongs to no active pointer, so it threw and took
   * the placement down with it. That is why replay worked on a mouse and never
   * on a tablet.
   */
  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    type Drag = {
      origin: { x: number; y: number };
      current: { x: number; y: number };
      pointerId: number;
    };
    let drag: Drag | null = null;
    let frame = 0;
    /** rAF id of an in-flight hand-off, so a fast second tap cancels the first. */
    let handoff = 0;

    const readViewport = (): TextPlaceViewport => {
      const state = apiRef.current?.getAppState() as
        | {
            zoom?: { value?: number };
            scrollX?: number;
            scrollY?: number;
            offsetLeft?: number;
            offsetTop?: number;
          }
        | undefined;
      return {
        zoom: state?.zoom?.value ?? 1,
        scrollX: state?.scrollX ?? 0,
        scrollY: state?.scrollY ?? 0,
        offsetLeft: state?.offsetLeft ?? 0,
        offsetTop: state?.offsetTop ?? 0,
      };
    };

    const boardPoint = (clientX: number, clientY: number) => {
      const boardRect = root.getBoundingClientRect();
      return { x: clientX - boardRect.left, y: clientY - boardRect.top };
    };

    const openEditable = () =>
      document.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg");

    const interactiveCanvas = () =>
      root.querySelector("canvas.excalidraw__canvas.interactive") ??
      root.querySelector("canvas.excalidraw__canvas");

    const paintGhost = (d: Drag) => {
      const ghost = textPlaceGhostRef.current;
      if (!ghost) return;
      const a = boardPoint(d.origin.x, d.origin.y);
      const b = boardPoint(d.current.x, d.current.y);
      const viewport = readViewport();
      const min = minTextBox(fontSizeRef.current, viewport.zoom);
      const dragged =
        Math.abs(d.current.x - d.origin.x) > TEXT_TAP_SLOP_PX ||
        Math.abs(d.current.y - d.origin.y) > TEXT_TAP_SLOP_PX;
      if (dragged) {
        ghost.setSize(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ghost.move(Math.min(a.x, b.x), Math.min(a.y, b.y));
      } else {
        // Preview the box a release would actually drop, not a dot.
        ghost.setSize(min.width * viewport.zoom, min.height * viewport.zoom);
        ghost.move(a.x, a.y);
      }
      ghost.setVisible(true);
    };

    const hideGhost = () => {
      textPlaceGhostRef.current?.setVisible(false);
    };

    /**
     * Drop the student's blank text boxes.
     *
     * Placing leaves an empty element behind whenever the editor is dismissed
     * without typing, and they are invisible but selectable. Template text is
     * tagged and never touched.
     */
    const cullEmptyStudentText = () => {
      const api = apiRef.current;
      if (!api) return;
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
        if ((el.originalText ?? el.text ?? "").trim().length > 0) return el;
        changed = true;
        return { ...el, isDeleted: true };
      });
      if (!changed) return;
      api.updateScene({
        elements: next,
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };

    /** Run `task` once the open editor has committed itself, or give up. */
    const afterEditorCloses = (task: () => void, framesLeft = 24) => {
      if (!openEditable()) {
        task();
        return;
      }
      if (framesLeft <= 0) {
        // The editor is wedged open. Blurring is the last thing that reliably
        // commits it; placing on top of it would only be refused.
        openEditable()?.blur();
        handoff = requestAnimationFrame(() => {
          handoff = 0;
          task();
        });
        return;
      }
      handoff = requestAnimationFrame(() => {
        handoff = 0;
        afterEditorCloses(task, framesLeft - 1);
      });
    };

    const placeText = (d: Drag) => {
      const api = apiRef.current;
      if (!api) return;

      const viewport = readViewport();
      const rect = textPlaceRect(d.origin, d.current, viewport, fontSizeRef.current);
      const fontFamily = textModeRef.current === "code" ? FONT_CODE : FONT_UI;
      const skeletons: Skeleton[] = [
        {
          type: "text",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          // Empty, not a placeholder character: whatever is here is what the
          // student has to backspace over before they can type.
          text: "",
          fontSize: fontSizeRef.current,
          fontFamily,
          lineHeight: defaultLineHeight(fontFamily),
          strokeColor: inkColorRef.current,
          textAlign: "left",
          verticalAlign: "top",
          autoResize: rect.autoResize,
          roughness: 0,
        },
      ];
      const created = convert(skeletons) as Array<{ id: string; [key: string]: unknown }>;
      if (created.length === 0) return;
      const textEl = created[0];

      const live = api.getSceneElements() as Array<{
        id: string;
        isDeleted?: boolean;
        [key: string]: unknown;
      }>;
      api.updateScene({
        elements: [...live.filter((el) => !el.isDeleted), ...created],
        appState: {
          // Selecting it is what makes the hand-off unambiguous: `startTextEditing`
          // prefers the single selected text element over whatever the pointer
          // happens to be over, so the double-click cannot bind our note into a
          // region rectangle underneath it.
          selectedElementIds: { [textEl.id]: true },
          selectedGroupIds: {},
          editingGroupId: null,
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      // Next frame: the selection has to be in Excalidraw's state before the
      // double-click reads it back.
      handoff = requestAnimationFrame(() => {
        handoff = 0;
        const canvas = interactiveCanvas();
        if (!(canvas instanceof Element)) return;
        const anchor = textEditorAnchor(rect);
        const at = textClientFromScene(anchor.x, anchor.y, readViewport());
        canvas.dispatchEvent(
          new MouseEvent("dblclick", {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: at.x,
            clientY: at.y,
            button: 0,
            detail: 2,
          }),
        );
        // A tablet keyboard sometimes needs the focus asserted again after
        // Excalidraw's own deferred focus; harmless when it is already focused.
        handoff = requestAnimationFrame(() => {
          handoff = 0;
          const editable = openEditable();
          if (editable) {
            if (document.activeElement !== editable) editable.focus();
            return;
          }
          // Editor refused to open — do not leave an invisible box behind.
          cullEmptyStudentText();
        });
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (activeToolRef.current !== "text") return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".lc-toolbar, .lc-map-controls, .lc-code-dock, .lc-pager, .lc-stamp-trash, .lc-capture-overlay",
        )
      ) {
        return;
      }
      // Presses inside the open editor belong to the editor.
      if (target.closest("textarea.excalidraw-wysiwyg, .excalidraw-textEditorContainer")) {
        return;
      }
      if (!target.closest(".excalidraw, .lc-board")) return;

      if (handoff) {
        cancelAnimationFrame(handoff);
        handoff = 0;
      }

      /*
       * `stopPropagation`, never `stopImmediatePropagation` or `preventDefault`.
       *
       * Excalidraw's own canvas handlers hang off the React root below us, so
       * stopping propagation is enough to keep the selection tool out of the
       * way. The open editor's commit-on-outside-press listener is on `window`
       * like ours, so `stopImmediatePropagation` would silence it and the box
       * would never commit. And `preventDefault` on a touch pointerdown is what
       * costs you the soft keyboard on Android.
       */
      event.stopPropagation();

      drag = {
        origin: { x: event.clientX, y: event.clientY },
        current: { x: event.clientX, y: event.clientY },
        pointerId: event.pointerId,
      };
      paintGhost(drag);
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (activeToolRef.current !== "text") return;

      if (!drag) {
        // Hover preview — only meaningful with a mouse or a hovering stylus.
        if (openEditable()) {
          hideGhost();
          return;
        }
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(".lc-toolbar, .lc-map-controls, .lc-code-dock, .lc-pager")
        ) {
          hideGhost();
          return;
        }
        const hitCanvas = interactiveCanvas();
        if (!(hitCanvas instanceof HTMLCanvasElement)) return;
        const canvasRect = hitCanvas.getBoundingClientRect();
        if (
          event.clientX < canvasRect.left ||
          event.clientX > canvasRect.right ||
          event.clientY < canvasRect.top ||
          event.clientY > canvasRect.bottom
        ) {
          hideGhost();
          return;
        }
        const viewport = readViewport();
        brushZoomRef.current = viewport.zoom;
        const ghost = textPlaceGhostRef.current;
        if (!ghost) return;
        const min = minTextBox(fontSizeRef.current, viewport.zoom);
        const p = boardPoint(event.clientX, event.clientY);
        ghost.setSize(min.width * viewport.zoom, min.height * viewport.zoom);
        ghost.move(p.x, p.y);
        ghost.setVisible(true);
        return;
      }

      if (event.pointerId !== drag.pointerId) return;
      event.stopPropagation();
      drag = { ...drag, current: { x: event.clientX, y: event.clientY } };
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (drag) paintGhost(drag);
        });
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finished: Drag = { ...drag, current: { x: event.clientX, y: event.clientY } };
      drag = null;
      event.stopPropagation();
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      hideGhost();
      // The open editor commits itself one frame after our pointerdown; placing
      // before that lands the new box in a scene it is about to rewrite.
      afterEditorCloses(() => {
        cullEmptyStudentText();
        placeText(finished);
      });
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      hideGhost();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      if (frame) cancelAnimationFrame(frame);
      if (handoff) cancelAnimationFrame(handoff);
      hideGhost();
    };
  }, [convert, interactive]);

  const setFontSize = useCallback((size: number) => {
    const clamped = Math.min(TEXT_FONT_MAX, Math.max(TEXT_FONT_MIN, Math.round(size)));
    setFontSizeState(clamped);
    // Forward-only: size applies to the next typed run / next placed box.
    // Do not rewrite the editing element or live wysiwyg — that used to resize
    // the whole box mid-type (Paint keeps prior glyphs at their own size).
    // Excalidraw still stores one fontSize per text element, so mixed sizes in
    // one box need separate placements until a rich-text editor exists.
    apiRef.current?.updateScene({
      appState: { currentItemFontSize: clamped },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
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
        viewBackgroundColor: transparentCanvasRef.current ? "transparent" : theme.background,
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

  const getZoomFloor = useCallback(
    () =>
      mobile && mobileRegionRef.current != null && fitZoomMinRef.current != null
        ? fitZoomMinRef.current
        : ZOOM_MIN,
    [mobile],
  );

  const getBoardCenter = useCallback((): { x: number; y: number } => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }, []);

  /**
   * Push a zoom level to the pill now and to React once the gesture stops.
   *
   * Safe to call on every frame of an animated zoom — see the note on
   * {@link zoomPctSettleRef} for why the two go at different speeds.
   */
  const showZoom = useCallback((pct: number) => {
    zoomIndicatorRef.current?.show(pct);
    if (zoomPctSettleRef.current) window.clearTimeout(zoomPctSettleRef.current);
    zoomPctSettleRef.current = window.setTimeout(() => {
      zoomPctSettleRef.current = 0;
      setZoomPct((current) => (current === pct ? current : pct));
    }, 140);
  }, []);

  useEffect(
    () => () => {
      if (zoomPctSettleRef.current) window.clearTimeout(zoomPctSettleRef.current);
    },
    [],
  );

  const applyZoomAtViewport = useCallback(
    (next: number, viewportX: number, viewportY: number) => {
      userAdjustedCameraRef.current = true;
      const floor = getZoomFloor();
      const clamped = clampZoom(next, floor);
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
        offsetLeft?: number;
        offsetTop?: number;
        zoom?: { value?: number };
      };
      let appState = getStateForZoom(
        { viewportX, viewportY, nextZoom: clamped },
        state,
      );
      const bounds = pageBoundsRef.current;
      if (
        mobile &&
        mobileRegionRef.current != null &&
        bounds &&
        typeof state.width === "number" &&
        typeof state.height === "number"
      ) {
        const inset = measureChromeInsets(
          boardRef.current,
          toolbarHeightRef.current,
          mapChromeHiddenRef.current,
          mobile,
        );
        const clampedScroll = clampScrollToBounds(
          appState.scrollX,
          appState.scrollY,
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
      showZoom(Math.round(clamped * 100));
    },
    [getZoomFloor, mobile, showZoom],
  );

  const interpolateZoomAnim = useCallback((): number | null => {
    const anim = zoomAnimRef.current;
    if (!anim) return null;
    const t = Math.min(1, (performance.now() - anim.start) / ZOOM_ANIM_MS);
    return anim.from + (anim.to - anim.from) * zoomEaseOut(t);
  }, []);

  const runZoomAnimFrame = useCallback(() => {
    const anim = zoomAnimRef.current;
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.start) / ZOOM_ANIM_MS);
    const z = anim.from + (anim.to - anim.from) * zoomEaseOut(t);
    const { x, y } = getBoardCenter();
    applyZoomAtViewport(z, x, y);
    if (t < 1) {
      anim.rafId = requestAnimationFrame(runZoomAnimFrame);
    } else {
      applyZoomAtViewport(anim.to, x, y);
      zoomAnimRef.current = null;
      // The last frame of the last retarget: re-level the tiles and let the
      // background pass sharpen what the animation blitted soft.
      rasterInkRef.current?.setCameraMoving(false);
    }
  }, [applyZoomAtViewport, getBoardCenter]);

  const retargetZoomBy = useCallback(
    (direction: 1 | -1) => {
      const floor = getZoomFloor();
      const anim = zoomAnimRef.current;
      const currentDest = anim?.to ?? readZoom();
      const factor = direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newTo = clampZoom(currentDest * factor, floor);
      if (Math.abs(newTo - currentDest) < 1e-6) return;

      let from: number;
      if (anim) {
        from = interpolateZoomAnim() ?? readZoom();
        if (anim.rafId != null) cancelAnimationFrame(anim.rafId);
      } else {
        from = readZoom();
      }
      if (Math.abs(newTo - from) < 1e-6) return;

      zoomAnimRef.current = {
        from,
        to: newTo,
        start: performance.now(),
        rafId: null,
      };
      // Idempotent, so a held button retargeting every 220ms does not restart
      // the pin — the level stays held across the whole run of presses.
      rasterInkRef.current?.setCameraMoving(true);
      runZoomAnimFrame();
    },
    [getZoomFloor, interpolateZoomAnim, readZoom, runZoomAnimFrame],
  );

  const zoomIn = useCallback(() => retargetZoomBy(1), [retargetZoomBy]);
  const zoomOut = useCallback(() => retargetZoomBy(-1), [retargetZoomBy]);

  useEffect(
    () => () => {
      const anim = zoomAnimRef.current;
      if (anim?.rafId != null) cancelAnimationFrame(anim.rafId);
    },
    [],
  );

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

      /*
       * The wheel reads the page. It is the only thing it does now.
       *
       * Zoom-to-wheel and shift-to-pan were both ways of moving a camera that
       * no longer moves: the page is laid out at the reading size and fills the
       * width, so the only travel left is down the page.
       */
      {
        event.preventDefault();
        event.stopPropagation();
        userAdjustedCameraRef.current = true;
        pulseCameraMotion();
        const next = clampPanScroll(
          state.scrollX ?? 0,
          (state.scrollY ?? 0) - event.deltaY / zoom,
          zoom,
        );
        api.updateScene({
          appState: { scrollY: next.scrollY },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }

    };

    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [clampPanScroll, interactive, mobile, pulseCameraMotion, reportCodeSlot, showZoom]);

  type FitMode = "frame" | "camera" | "both";

  const runFit = useCallback(
    (regionId?: string | null, mode: FitMode = "both") => {
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

      // Prefer the frame alone for page-locked fits so we never zoom to all pages.
      let focus =
        focusFrames.length > 0
          ? focusFrames
          : target.length > 0
            ? target
            : live;

      const state = api.getAppState() as {
        width?: number;
        height?: number;
      };
      // Prefer the live board box — appState can lag a coach open/close by a frame.
      const boardBox = boardRef.current?.getBoundingClientRect();
      const viewWidth = Math.max(
        num(state.width, 0),
        boardBox && boardBox.width > 8 ? Math.round(boardBox.width) : 0,
      );
      const viewHeight = Math.max(
        num(state.height, 0),
        boardBox && boardBox.height > 8 ? Math.round(boardBox.height) : 0,
      );
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

      const isScratchPage = typeof page === "string" && page.startsWith("pad-");

      if (mode === "frame" || mode === "both") {
        /*
         * Grow/shrink the focus *frame* so width-fill zoom also fills height.
         * Zoom alone cannot do this when the authored aspect is wider than the hole.
         */
        const primary =
          focus.find((element) => element.customData?.lcRegionFrame) ??
          (focusFrames[0] ?? null);
        if (primary && typeof primary.id === "string") {
          const regionKey = primary.customData?.lcRegion;
          const isScratch =
            typeof regionKey === "string" && regionKey.startsWith("pad-");
          const frameW = Math.max(
            1,
            isScratch ? SCRATCH_PAGE_W : num(primary.width, REGIONS.constraints.w),
          );
          // Raw ratio — do not floor to ZOOM_MIN or fillHeight collapses.
          const zoomForWidth = Math.max(0.05, Math.min(ZOOM_MAX, availWidth / frameW));
          const fillHeight = availHeight / zoomForWidth;
          const regionMin =
            typeof regionKey === "string" && regionKey in REGION_MIN
              ? REGION_MIN[regionKey as RegionId].minH
              : 800;
          const nextH = Math.max(regionMin, Math.round(fillHeight));
          const curH = num(primary.height, 0);
          if (Math.abs(curH - nextH) > 1 || Math.abs(num(primary.width, 0) - frameW) > 1) {
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
      }

      if (mode === "camera" || mode === "both") {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const element of focus) {
          if (typeof element.x !== "number" || typeof element.y !== "number") continue;
          // Page fit: only the frame size matters (ignore text that may extend).
          if (page && !element.customData?.lcRegionFrame) continue;
          minX = Math.min(minX, element.x);
          minY = Math.min(minY, element.y);
          maxX = Math.max(maxX, element.x + num(element.width, 0));
          maxY = Math.max(maxY, element.y + num(element.height, 0));
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
          // Fall back to whatever we focused if no frame was tagged.
          for (const element of focus) {
            if (typeof element.x !== "number" || typeof element.y !== "number") continue;
            minX = Math.min(minX, element.x);
            minY = Math.min(minY, element.y);
            maxX = Math.max(maxX, element.x + num(element.width, 0));
            maxY = Math.max(maxY, element.y + num(element.height, 0));
          }
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

        const boxWidth = Math.max(1, maxX - minX);
        const boxHeight = Math.max(1, maxY - minY);
        /*
         * A document fits its width. A page fits both.
         *
         * Fitting both axes is right for a sheet of paper — the whole thing is
         * meant to be on screen at once. It is catastrophic for a document,
         * because the page is as tall as the text: a long note zooms out until
         * every line of it is visible, which is to say until none of it is
         * readable, and the taller the file the smaller it gets. Growing the
         * frame to the content made that worse rather than better.
         *
         * Width-only is what a reader does. The column lands at the screen's
         * width, the type stays the size it was authored at, and the height
         * that does not fit is the thing you scroll — which the pan clamp then
         * permits precisely because the content is taller than the viewport.
         */
        /*
         * Ask the scene, not React.
         *
         * This used to read a ref assigned during render, which is a different
         * clock from the one the fit runs on: opening a document fits before
         * the render that would have set it, so the very fit that matters saw
         * "not a document" and shrank the whole file onto one screen. The frame
         * carries the answer now, so it cannot arrive late.
         */
        const widthOnly =
          focus.some(
            (element) =>
              (element as { customData?: { lcDocumentPage?: boolean } }).customData
                ?.lcDocumentPage === true,
          ) || page === "code";
        const zoom = clampZoom(
          widthOnly
            ? availWidth / boxWidth
            : Math.min(availWidth / boxWidth, availHeight / boxHeight),
        );
        fitZoomMinRef.current = zoom;
        // Tablet locks zoom-out at page fit; desktop (coach on the right) stays free.
        setZoomFloorPct(
          Math.round((mobile && page ? zoom : ZOOM_MIN) * 100),
        );
        pageBoundsRef.current = { minX, minY, maxX, maxY };

        const slackX = Math.max(0, availWidth - boxWidth * zoom);
        const slackY =
          isScratchPage || widthOnly
            ? 0
            : Math.max(0, availHeight - boxHeight * zoom);
        fittingCameraRef.current = true;
        api.updateScene({
          appState: {
            zoom: { value: zoom },
            scrollX: (inset.left + slackX / 2) / zoom - minX,
            scrollY: (inset.top + slackY / 2) / zoom - minY,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(() => {
          fittingCameraRef.current = false;
        });
        setZoomPct(Math.round(zoom * 100));
        requestAnimationFrame(reportCodeSlot);
        requestAnimationFrame(reportLinedSlot);
        requestAnimationFrame(reportTitleSlot);
      }
    },
    [mobile, reportCodeSlot, reportLinedSlot, reportTitleSlot],
  );

  const fitFrame = useCallback(
    (regionId?: string | null) => {
      runFit(regionId, "frame");
    },
    [runFit],
  );

  const fitCamera = useCallback(
    (regionId?: string | null) => {
      runFit(regionId, "camera");
    },
    [runFit],
  );

  const fitView = useCallback(
    (regionId?: string | null) => {
      userAdjustedCameraRef.current = false;
      runFit(regionId, "both");
    },
    [runFit],
  );

  /** Resize the page frame and refit zoom/scroll to the chrome hole (window/board resize). */
  const refitToViewport = useCallback(
    (regionId?: string | null) => {
      userAdjustedCameraRef.current = false;
      runFit(regionId, "both");
    },
    [runFit],
  );

  /** Run fit after Excalidraw has applied scene + container size. */
  const scheduleFitView = useCallback(() => {
    const run = () => refitToViewport();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        run();
        window.setTimeout(run, 60);
        window.setTimeout(run, 200);
      });
    });
  }, [refitToViewport]);

  useEffect(() => {
    reportLinedSlot();
  }, [linedPaper, reportLinedSlot]);

  // A document arriving (or the page frame growing under it) has to place the
  // content layer before the first frame it is visible in.
  useEffect(() => {
    reportContentSlot();
  }, [pageContent, reportContentSlot]);

  // Slot nodes mount one frame after their flags flip — push geometry then.
  useLayoutEffect(() => {
    if (!pageContent) return;
    reportContentSlot();
  }, [pageContent, contentSceneWidth, reportContentSlot]);

  useLayoutEffect(() => {
    if (!linedSlotOn) return;
    const next = lastLinedSlotRef.current;
    const node = linedSlotNodeRef.current;
    if (!next || !node) return;
    node.style.left = `${next.left}px`;
    node.style.top = `${next.top}px`;
    node.style.width = `${next.width}px`;
    node.style.height = `${next.height}px`;
    node.style.backgroundSize = `100% ${next.gap}px`;
    node.style.backgroundPosition = `0 ${next.phase}px`;
  }, [linedSlotOn]);

  /**
   * Grow the page to the document, and tell the pan clamp about it.
   *
   * `syncPageVisibility` is what recomputes `pageBoundsRef`, and that ref is
   * the entire reason scrolling works: the clamp allows travel only while the
   * content is taller than the viewport, so a frame left at its floor is a
   * document you cannot scroll past the first screen of. Growing the frame
   * without refreshing the bounds fixes nothing, which is why both happen here.
   */
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !pageContentHeight || pageContentHeight < 1) return;
    const current = api.getSceneElements() as SceneElementLike[];
    const page = mobileRegionRef.current;
    const frame = current.find((el) => {
      const meta = (el as { customData?: { lcMdInkFrame?: boolean; lcRegion?: string; lcRegionFrame?: boolean } })
        .customData;
      // The markdown page has its own marker; the code page is just the frame
      // of the region we are on. Both grow to the content they carry.
      return meta?.lcMdInkFrame || (meta?.lcRegionFrame && meta.lcRegion === page);
    }) as (SceneElementLike & { height?: number }) | undefined;
    if (!frame) return;
    if (typeof frame.height === "number" && Math.abs(frame.height - pageContentHeight) < 1) {
      return;
    }
    const isMdFrame = Boolean(
      (frame as { customData?: { lcMdInkFrame?: boolean } }).customData?.lcMdInkFrame,
    );
    api.updateScene({
      elements: current.map((el) =>
        el === frame
          ? {
              ...(el as object),
              height: pageContentHeight,
              // Md frame must stay locked — see buildMdInkTemplate.
              ...(isMdFrame ? { locked: true } : {}),
              versionNonce: Math.random() * 2 ** 31,
            }
          : el,
      ) as unknown[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    syncPageVisibility();
    scheduleSlotReports();
  }, [pageContent, pageContentHeight, scheduleSlotReports, syncPageVisibility]);

  // A toggle mid-gesture must not leave a stale pin behind.
  useEffect(() => {
    if (!scrollMode) lockedScrollXRef.current = null;
  }, [scrollMode]);

  useEffect(() => {
    return () => {
      if (cameraMotionTimerRef.current) window.clearTimeout(cameraMotionTimerRef.current);
      cameraMotionTimerRef.current = 0;
      cameraMotionActiveRef.current = false;
    };
  }, []);

  // Entering or leaving md-ink flips the canvas between opaque and see-through
  // after the theme has already been applied, so it needs its own push.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({
      appState: {
        viewBackgroundColor: transparentCanvas
          ? "transparent"
          : (BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0])
              .background,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [transparentCanvas, themeId]);

  useEffect(() => {
    reportTitleSlot();
  }, [mobileRegion, interactive, reportTitleSlot]);

  /** Page-locked boards: grow the frame and refit width on every board resize. */
  useEffect(() => {
    if (!interactive) return;
    const board = boardRef.current;
    if (!board || typeof ResizeObserver === "undefined") return;
    let timer: number | null = null;
    const run = () => {
      if (mobileRegionRef.current === null) return;
      // Once the user has zoomed or panned, the camera is theirs: resize the
      // page frame to the new viewport, but leave zoom and scroll alone.
      if (userAdjustedCameraRef.current) {
        fitFrame();
        return;
      }
      refitToViewport();
    };
    const observer = new ResizeObserver(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(run, 60);
    });
    observer.observe(board);
    const onWindowResize = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(run, 60);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [interactive, fitFrame, refitToViewport]);

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
    refitToViewport();
  }, [refitToViewport]);

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
      refitToViewport();
      await wait(50);
      refitToViewport();
      await wait(120);
      refitToViewport();
      await waitFrame();
    })();
  }, [refitToViewport]);

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

  /** Place an image element at viewport center (or an explicit scene rect). */
  const insertImageFromDataURL = useCallback(
    async (
      dataURL: string,
      mimeType: string,
      place?: { x: number; y: number; width: number; height: number },
    ) => {
      const api = apiRef.current;
      if (!api) return;
      const fileId = newImageFileId();
      const created = Date.now();
      api.addFiles?.([
        {
          id: fileId,
          mimeType: mimeType || "image/png",
          dataURL,
          created,
        },
      ]);

      let width: number;
      let height: number;
      let x: number;
      let y: number;
      if (place) {
        width = Math.max(1, place.width);
        height = Math.max(1, place.height);
        x = place.x;
        y = place.y;
      } else {
        const size = await loadImageSize(dataURL);
        const maxEdge = 420;
        const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
        width = Math.max(1, Math.round(size.width * scale));
        height = Math.max(1, Math.round(size.height * scale));
        const state = api.getAppState() as {
          scrollX?: number;
          scrollY?: number;
          width?: number;
          height?: number;
          zoom?: { value?: number };
        };
        const zoom = state.zoom?.value ?? 1;
        x = Math.round(-(state.scrollX ?? 0) + (state.width ?? 1200) / (2 * zoom) - width / 2);
        y = Math.round(-(state.scrollY ?? 0) + (state.height ?? 800) / (2 * zoom) - height / 2);
      }

      const pieces = convertToExcalidrawElements(
        [
          {
            type: "image",
            x,
            y,
            width,
            height,
            fileId: fileId as never,
            status: "saved",
            scale: [1, 1],
          },
        ] as never,
        { regenerateIds: true },
      ) as Array<{
        id: string;
        customData?: Record<string, unknown> | null;
        [key: string]: unknown;
      }>;

      const tagged = pieces.map((element) => ({
        ...element,
        locked: false,
        customData: {
          ...(element.customData ?? {}),
          lcStamp: true,
          lcImage: true,
        },
      }));

      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...tagged],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setTool("selection");
      setCaptureMenuOpen(false);
      setCaptureArmed(false);
      setCaptureRegion(null);
    },
    [setTool],
  );

  const pickImageFile = useCallback(() => {
    setCaptureMenuOpen(false);
    setShapesOpen(false);
    imageInputRef.current?.click();
  }, []);

  const onImageFileChosen = useCallback(
    async (file: File | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      const dataURL = await blobToDataURL(file);
      await insertImageFromDataURL(dataURL, file.type || "image/png");
    },
    [insertImageFromDataURL],
  );

  /**
   * Save the PNG and say what happened.
   *
   * Every capture reports now, whether or not a file was written: "Added to the
   * board" is still an outcome, and it is the one the student sees when
   * auto-save is off. Silence used to be the only feedback either way.
   */
  const reportCapture = useCallback(async (blob: Blob) => {
    if (!loadAutoSaveCaptures()) {
      captureFeedbackRef.current?.toast("Added to the board");
      return;
    }
    try {
      const result = await saveCaptureToDevice(blob);
      captureFeedbackRef.current?.toast(
        describeCaptureResult(result),
        result.outcome === "failed" ? "error" : "ok",
      );
    } catch (cause) {
      captureFeedbackRef.current?.toast(`Could not save — ${String(cause)}`, "error");
    }
  }, []);

  const captureEntireBoard = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    setCaptureMenuOpen(false);
    const feedback = captureFeedbackRef.current;
    // Countdown first, so whatever is mid-thought has a moment to settle and the
    // shot is not a surprise. Zero seconds shoots straight through.
    if (feedback && !(await feedback.countdown(loadCaptureCountdown(), "Capturing board"))) {
      return;
    }
    feedback?.flash();
    const blob = await exportBoardBlob(api, rasterInkRef.current?.getOps() ?? []);
    if (!blob || blob.size === 0) {
      feedback?.toast("Nothing to capture", "error");
      return;
    }
    const dataURL = await blobToDataURL(blob);
    await insertImageFromDataURL(dataURL, "image/png");
    await reportCapture(blob);
  }, [insertImageFromDataURL, reportCapture]);

  const beginRegionCapture = useCallback(() => {
    setCaptureMenuOpen(false);
    setShapesOpen(false);
    setTool("hand");
    setCaptureArmed(true);
    setCaptureRegion(null);
    captureDragRef.current = null;
  }, [setTool]);

  useEffect(() => {
    if (!captureArmed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        captureDragRef.current = null;
        setCaptureRegion(null);
        setCaptureArmed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureArmed]);

  const finishRegionCapture = useCallback(
    async (originX: number, originY: number, currentX: number, currentY: number) => {
      const api = apiRef.current;
      setCaptureArmed(false);
      setCaptureRegion(null);
      if (!api) return;
      const a = clientToScene(originX, originY);
      const b = clientToScene(currentX, currentY);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const width = Math.abs(b.x - a.x);
      const height = Math.abs(b.y - a.y);
      if (width < 8 || height < 8) {
        captureFeedbackRef.current?.toast("Region too small to capture", "error");
        return;
      }
      const feedback = captureFeedbackRef.current;
      // Same ceremony as the full board: the region is already drawn, so the
      // countdown is the cue that the shot is coming.
      if (feedback && !(await feedback.countdown(loadCaptureCountdown(), "Capturing region"))) {
        return;
      }
      feedback?.flash();
      const blob = await exportSceneFrameBlob(
        api,
        rasterInkRef.current?.getOps() ?? [],
        { x, y, width, height },
      );
      if (!blob || blob.size === 0) {
        feedback?.toast("Nothing to capture", "error");
        return;
      }
      const dataURL = await blobToDataURL(blob);
      await insertImageFromDataURL(dataURL, "image/png", { x, y, width, height });
      await reportCapture(blob);
    },
    [clientToScene, insertImageFromDataURL, reportCapture],
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
    // Handwriting lives on the raster layer, not in the scene, so replacing the
    // elements leaves every stroke on screen. Reset is now the only board-wide
    // control — it has to clear both halves, which is what its dialog promises.
    rasterInkRef.current?.clear();
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
    /*
     * Fit inside the same commit, not on the next frame.
     *
     * The seed skeletons are at their authored size, and the fit is what grows
     * the page frame to the viewport and sets the camera. Deferring it by a
     * frame let Excalidraw paint the authored layout once at the old camera —
     * the snap-then-resize everyone sees. `updateScene` writes the elements
     * synchronously and the camera is a state update, so doing both here lands
     * them in one paint.
     */
    refitToViewport();
    // Fonts and text metrics settle a beat later; these only nudge.
    scheduleFitView();
  }, [convert, refitToViewport, scheduleFitView, themeId]);

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

  const wasInteractiveRef = useRef(false);

  // Page turn / prepare→ready: refit the locked page so scratch fills the chrome hole.
  useEffect(() => {
    const next = mobileRegion ?? null;
    const previous = prevMobileRegionRef.current;
    const becameInteractive = interactive && !wasInteractiveRef.current;
    wasInteractiveRef.current = interactive;
    prevMobileRegionRef.current = next;
    if (!interactive) return;
    if (!becameInteractive && previous === next) return;
    userAdjustedCameraRef.current = false;
    // Hide the other pages *before* fitting: a page is the only thing on the
    // canvas, so zooming out on a tablet shows one frame, not the whole column.
    // Ink clip tracks the same box — without this, marks from the previous page
    // can flash on the next one until the next camera tick.
    syncPageVisibility();
    reportCodeSlot();
    rasterInkRef.current?.syncCamera();
    void settleFitView().then(() => {
      reportCodeSlot();
      rasterInkRef.current?.syncCamera();
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

      /*
       * Scroll and zoom fire `onChange` with the same elements.
       *
       * A wheel frame used to pay for region layout, a full element walk,
       * page-visibility rewrite, stamp chrome, and an App `onChange` (which
       * fingerprints the whole board for autosave). That is the camera-perf
       * class of bug again — the page was being reconciled because the camera
       * moved. Slots already update from `onScrollChange`; skip the rest.
       */
      if (
        cameraMotionActiveRef.current ||
        clampingScrollRef.current ||
        fittingCameraRef.current ||
        layoutSyncingRef.current
      ) {
        return;
      }

      /*
       * Page-tall frames + selection ants = scroll death.
       *
       * Hand/scroll mode never needs a selection. If a document frame (md-ink
       * or region) is selected, Excalidraw paints animated dashes around the
       * whole page every frame — that is the lagging box on the screen edge.
       */
      const selectedIds = Object.entries(appState?.selectedElementIds ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id);
      if (selectedIds.length > 0 && activeToolRef.current === "hand") {
        api.updateScene({
          appState: { selectedElementIds: {} },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
      if (selectedIds.length > 0) {
        const live = api.getSceneElements() as Array<{
          id: string;
          customData?: { lcMdInkFrame?: boolean } | null;
        }>;
        const hitMdFrame = selectedIds.some((id) => {
          const el = live.find((candidate) => candidate.id === id);
          return Boolean(el?.customData?.lcMdInkFrame);
        });
        if (hitMdFrame) {
          const nextSelected = { ...(appState?.selectedElementIds ?? {}) };
          for (const id of selectedIds) {
            const el = live.find((candidate) => candidate.id === id);
            if (el?.customData?.lcMdInkFrame) delete nextSelected[id];
          }
          api.updateScene({
            appState: { selectedElementIds: nextSelected },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          return;
        }
      }

      const editingId = appState?.editingTextElement?.id ?? null;
      const structuralUi =
        Boolean(appState?.isResizing) ||
        Boolean(appState?.resizingElement) ||
        Boolean(appState?.newElement);
      const selectionSig = Object.entries(appState?.selectedElementIds ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id)
        .sort()
        .join("\0");

      // Same elements array reference = camera/selection chrome only. O(1).
      if (
        !structuralUi &&
        _elements !== undefined &&
        _elements === lastElementsArgRef.current &&
        selectionSig === lastSelectionSigRef.current &&
        editingId === editingTextIdRef.current
      ) {
        return;
      }
      if (_elements !== undefined) lastElementsArgRef.current = _elements;

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
        fontFamily?: number;
        lineHeight?: number;
        version?: number;
        versionNonce?: number;
        customData?: { lcRegion?: string; lcVizId?: string; lcRegionFrame?: boolean } | null;
        [key: string]: unknown;
      }>;

      let elementsRev = current.length * 2654435761;
      for (const el of current) {
        elementsRev =
          (elementsRev +
            ((typeof el.version === "number" ? el.version : 0) | 0) * 131 +
            ((typeof el.versionNonce === "number" ? el.versionNonce : 0) | 0)) |
          0;
      }

      if (
        !structuralUi &&
        elementsRev === lastSceneElementsRevRef.current &&
        selectionSig === lastSelectionSigRef.current &&
        editingId === editingTextIdRef.current
      ) {
        return;
      }
      lastSceneElementsRevRef.current = elementsRev;
      lastSelectionSigRef.current = selectionSig;

      // Frames: pin column position, zero rotation; resize height/width still works.
      applyRegionLayout();
      reportCodeSlot();

      const prevEditingId = editingTextIdRef.current;

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

        const wantFont = textModeRef.current === "code" ? FONT_CODE : FONT_UI;
        if (el.id === editingId && el.fontFamily !== wantFont) {
          changed = true;
          return {
            ...el,
            fontFamily: wantFont,
            lineHeight: defaultLineHeight(wantFont),
            version: (typeof el.version === "number" ? el.version : 0) + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
          };
        }

        const raw = (el.originalText ?? el.text ?? "").trim();

        // While the text tool is active, keep empty boxes so click-around can
        // open a new editor. Cull empties only after leaving the tool (setTool).
        if (el.id !== editingId && raw.length === 0 && activeTool !== "text") {
          changed = true;
          return { ...el, isDeleted: true };
        }

        // Leave autoResize alone — Paint-like single-tap placement needs it true.
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
          // Stay on the Text tool: dismissing an empty box is usually the press
          // that places the next one. Nothing to re-arm — our own gesture owns
          // placement and Excalidraw is meant to sit on `selection` throughout.
          // Only the caret Excalidraw resets on submit has to be put back.
          window.requestAnimationFrame(() => {
            if (activeToolRef.current !== "text") return;
            apiRef.current?.setCursor?.("text");
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
      exportVizPng: async (programId: string) => {
        const api = apiRef.current;
        if (!api) return "";
        const group = (api.getSceneElements() as SceneElementLike[]).filter(
          (el) => !el.isDeleted && el.customData?.lcVizId === programId,
        );
        if (group.length === 0) return "";
        // Crop to the group's own bounds with a little air, so the model is
        // looking at the diagram rather than hunting for it.
        const pad = 24;
        const minX = Math.min(...group.map((el) => el.x)) - pad;
        const minY = Math.min(...group.map((el) => el.y)) - pad;
        const maxX = Math.max(...group.map((el) => el.x + el.width)) + pad;
        const maxY = Math.max(...group.map((el) => el.y + el.height)) + pad;
        return captureImage(
          () =>
            exportRegionBlob(api, [], group, {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            }),
          { maxEdge: 900, maxBase64: 2 * 1024 * 1024 },
        );
      },
      getStrokes: () => captureStrokes(elements()),
      getInkStrokes: () => inkStrokesFromOps(rasterInkRef.current?.getOps() ?? []),
      getInkOpCount: () => (rasterInkRef.current?.getOps() ?? []).length,
      isInking: () => rasterInkRef.current?.isDrawing() ?? false,
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
      fitFrame,
      refitToViewport,
      fitRegion: (regionId: RegionId | string) => {
        refitToViewport(regionId);
      },
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
        const rawFiles = (api?.getFiles() ?? {}) as Record<string, BoardBinaryFile>;
        const files: Record<string, BoardBinaryFile> = {};
        for (const [id, file] of Object.entries(rawFiles)) {
          if (!file || typeof file.dataURL !== "string") continue;
          files[id] = {
            id: file.id ?? id,
            mimeType: file.mimeType ?? "image/png",
            dataURL: file.dataURL,
            created: file.created ?? Date.now(),
          };
        }
        return {
          v: 1 as const,
          elements: kept as unknown[],
          appState: {
            scrollX: state.scrollX ?? 0,
            scrollY: state.scrollY ?? 0,
            zoom: state.zoom?.value ?? 1,
          },
          ink,
          ...(Object.keys(files).length > 0 ? { files } : {}),
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
        if (options?.files && apiRef.current?.addFiles) {
          const list = Object.values(options.files).map((file) => ({
            id: file.id,
            mimeType: file.mimeType,
            dataURL: file.dataURL,
            created: file.created,
          }));
          if (list.length > 0) apiRef.current.addFiles(list);
        }
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
            viewBackgroundColor: transparentCanvasRef.current ? "transparent" : theme.background,
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
    [convert, elements, fitCamera, fitCodeToSource, fitCurrentView, fitFrame, fitView, refitToViewport, settleFitView, waitForTemplate, resetTemplate, scheduleFitView, setTool, syncPageVisibility, themeId, undoBoard, zoomIn, zoomOut],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  const initialData = useMemo(
    () => {
      const prefs = inkPrefsRef.current;
      return {
        appState: {
          viewBackgroundColor: transparentCanvas ? "transparent" : theme.background,
          currentItemStrokeColor: resolveInkColor(themeId, prefs.inkColor),
          currentItemStrokeWidth: prefs.penWidth,
          currentItemRoughness: 1,
          // Not the hand-drawn default: typed notes should read like notes.
          currentItemFontFamily: FONT_UI,
          currentItemFontSize: DEFAULT_FONT_SIZE,
          // Paint-like: single tap opens the editor (not drag-to-size).
          currentItemAutoResize: true,
        },
        // We call settleFitView ourselves — Excalidraw's default fits the entire
        // board and lands the problem as a postage stamp in the corner.
        scrollToContent: false,
      };
    },
    [theme.background, themeId, transparentCanvas],
  );

  return (
    <div
      ref={boardRef}
      className={[
        "lc-board",
        !interactive && "lc-board-idle",
        // The canvas is see-through in this mode, so the paper colour has to
        // come from somewhere — here, under everything, including the markdown.
        transparentCanvas && "lc-board-paper",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/*
        The markdown page, under everything.
        First in the DOM and on the lowest layer, so Excalidraw's shapes and the
        raster ink both draw over it. It is scaled, never reflowed — see
        `reportContentSlot`.
      */}
      {annotateCode && (
        <div className="lc-annotate-badge" aria-live="polite">
          <span className="lc-annotate-badge-dot" aria-hidden />
          Annotating — the editor is not taking typing
        </div>
      )}
      {pageContent && (
        <div
          ref={contentSlotNodeRef}
          className="lc-page-content-slot"
          aria-hidden
          style={{ width: contentSceneWidth }}
        >
          {pageContent}
        </div>
      )}
      {linedPaper && linedSlotOn && (
        <div ref={linedSlotNodeRef} className="lc-board-lined-overlay" aria-hidden />
      )}
      {interactive && pageTitle && titleSlot && (
        <div
          ref={titleSlotNodeRef}
          className="lc-page-title-slot"
          style={{ left: titleSlot.left, top: titleSlot.top, fontSize: titleSlot.fontPx }}
        >
          {pageTitle}
        </div>
      )}
      {interactive && (
        <>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="lc-hidden-file"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void onImageFileChosen(file);
            }}
          />
          <div
            className={[
              "lc-map-controls lc-map-controls-paged",
              mapChromeHidden ? "lc-map-controls-collapsed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="lc-map-chrome-left">
              {!mapChromeHidden && (
                <div className="lc-map-chrome-row">
                  {onThemePick && (
                    <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
                  )}
                  {annotateToggle && (
                    <button
                      type="button"
                      className={
                        annotateCode ? "lc-lined-toggle is-active" : "lc-lined-toggle"
                      }
                      aria-pressed={annotateCode}
                      aria-label={annotateCode ? "Hide toolbar" : "Show toolbar"}
                      title={
                        annotateCode
                          ? "Toolbar on — tap to scroll the page"
                          : "Toolbar — annotate this page"
                      }
                      onClick={() => setAnnotateCode((current) => !current)}
                    >
                      <AnnotateIcon on={annotateCode} />
                    </button>
                  )}
                  {linedPaperToggle && mobileRegion !== "code" && (
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
              )}
            </div>
            <div className="lc-board-dock">
              {!mapChromeHidden && bottomCenter}
              <div className="lc-toolbar-dock-anchor" aria-hidden />
              {/*
                The toolbar is annotate mode's toolbar.
                Every one of these tools puts marks on the page, and outside
                annotate mode the page is something you are reading and
                scrolling. A pen offered on a surface that is not accepting pen
                is the "it looks off" — so the whole strip goes with the mode
                rather than being present and inert.
              */}
              {!mapChromeHidden && annotateCode && (
              <BoardToolbar
                active={activeTool}
                onPick={setTool}
                themeId={themeId}
                inkColor={inkColor}
                onInk={setInk}
                handedness={inkHandedness}
                strokeWidth={strokeWidth}
                onStrokeWidth={setStrokeWidth}
                inkFullness={inkFullness}
                onInkFullness={setInkFullness}
                pressureSensitive={pressureSensitive}
                onPressureSensitive={setPressureSensitive}
                fontSize={fontSize}
                onFontSize={setFontSize}
                textMode={textMode}
                onTextMode={pickTextMode}
                shapesOpen={shapesOpen}
                onToggleShapes={() => {
                  if (shapesOpen) {
                    setShapesOpen(false);
                    return;
                  }
                  // Shape library is exclusive with drawing tools.
                  setTool("selection");
                  setShapesOpen(true);
                  setCaptureMenuOpen(false);
                }}
                onStamp={stamp}
                onPickImage={pickImageFile}
                captureMenuOpen={captureMenuOpen}
                onToggleCaptureMenu={() => {
                  setCaptureMenuOpen((open) => !open);
                  setShapesOpen(false);
                }}
                onCaptureEntire={captureEntireBoard}
                onCaptureRegion={beginRegionCapture}
                onReset={resetTemplate}
                onUndo={undoBoard}
                onRedo={redoBoard}
                mobile={mobile}
                onHeightChange={(height) => {
                  toolbarHeightRef.current = height;
                }}
              />
              )}
            </div>
            <div className="lc-map-chrome-right">
              <div className="lc-map-chrome-row">
                <button
                  type="button"
                  className={
                    mapChromeHidden ? "lc-chrome-eye is-dimmed" : "lc-chrome-eye"
                  }
                  aria-pressed={!mapChromeHidden}
                  aria-label={mapChromeHidden ? "Show board chrome" : "Hide board chrome"}
                  title={mapChromeHidden ? "Show controls" : "Hide controls"}
                  onClick={() => setMapChromeHidden((current) => !current)}
                >
                  <EyeIcon closed={mapChromeHidden} />
                </button>
              </div>
              {/*
                No zoom, no fit, no S/M/L. Annotations track the page in scene
                space — a reading-size switch reflows the frames without
                remapping ink, which is how marks ended up on the wrong page.
              */}
            </div>
            {coachFold}
          </div>
        </>
      )}
      {interactive && activeTool === "eraser" && <EraserBrush ref={eraserBrushRef} />}
      {interactive && <ZoomIndicator ref={zoomIndicatorRef} />}
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
        inkFullness={inkFullness}
        pressureClip={pressureClip}
        smoothing={inkSmoothing}
        smoothingMode={inkSmoothingMode}
        speedInk={inkSpeed}
        pressureSensitive={pressureSensitive}
        getViewport={getViewport}
        clip={inkClip}
        onChange={onChange}
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
              // Fires on pan as well as zoom, so only a *changed* level counts
              // as zooming. Otherwise every pan frame would restart the pill's
              // fade and hold it on screen for the whole gesture.
              const pct = Math.round(zoom.value * 100);
              if (lastZoomPctRef.current !== pct) {
                lastZoomPctRef.current = pct;
                showZoom(pct);
              }

              /*
               * Hold the column while a reading-mode drag is running.
               *
               * The hand tool is Excalidraw's and pans in two dimensions, so
               * the lock is a correction rather than a restraint: put `scrollX`
               * back where the drag started. Only during the drag — a zoom or a
               * fit moves the column legitimately, and the correction is
               * sub-pixel on any drag that is mostly vertical, which in reading
               * mode is all of them.
               */
              if (
                scrollModeRef.current &&
                handPanningRef.current &&
                !clampingScrollRef.current &&
                lockedScrollXRef.current !== null &&
                Math.abs(scrollX - lockedScrollXRef.current) > 0.05
              ) {
                clampingScrollRef.current = true;
                apiRef.current?.updateScene({
                  appState: { scrollX: lockedScrollXRef.current },
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
                requestAnimationFrame(() => {
                  clampingScrollRef.current = false;
                });
              }

              /*
               * Estimate the throw — from the hand, never from the correction.
               *
               * This is where the bounce actually came from, and why fixing the
               * inertia twice did not stop it. Drag past a boundary and each
               * frame goes: Excalidraw moves the view out, this samples the
               * delta, then the bounds clamp below snaps it back with
               * `updateScene` — which raises a *second* scroll event, whose
               * delta points back toward the middle. That reversed sample went
               * into the same average as the real ones, so a flick into a wall
               * lifted off with velocity pointing away from it and the view
               * sailed backwards. A literal rebound, produced by measuring our
               * own correction and calling it the user's hand.
               *
               * The snap-back frames are the ones raised while `clampingScroll`
               * is set. Skipping them leaves the estimate made only of movement
               * somebody's finger actually caused.
               */
              if (
                activeToolRef.current === "hand" &&
                handPanningRef.current &&
                inertiaFrameRef.current === 0 &&
                !clampingScrollRef.current
              ) {
                const now = performance.now();
                const last = lastPanScrollRef.current;
                if (last.t > 0) {
                  const dt = Math.max(1, now - last.t);
                  const instantX = (scrollX - last.x) / dt;
                  const instantY = (scrollY - last.y) / dt;
                  panVelocityRef.current = {
                    x: panVelocityRef.current.x * 0.65 + instantX * 0.35,
                    y: panVelocityRef.current.y * 0.65 + instantY * 0.35,
                  };
                }
                lastPanScrollRef.current = { x: scrollX, y: scrollY, t: now };
              }
              // Reblit the ink tiles for the new camera. Fires on zoom as well
              // as scroll, which is what keeps a smooth zoom smooth.
              if (!fittingCameraRef.current && !clampingScrollRef.current) {
                pulseCameraMotionRef.current();
              }
              if (!rasterInkRef.current?.isDrawing()) {
                rasterInkRef.current?.syncCamera();
              }
              scheduleSlotReports();

              // Tablet only — desktop keeps free pan (coach docks on the right).
              if (!fittingCameraRef.current && !clampingScrollRef.current) {
                userAdjustedCameraRef.current = true;
              }
              // The inertia step clamps every frame against the same bounds.
              // Clamping again here only lands a second `updateScene` on top of
              // the coast's own, which is the fight that made a flick judder.
              if (
                !mobileRef.current ||
                mobileRegionRef.current == null ||
                clampingScrollRef.current ||
                inertiaFrameRef.current !== 0
              ) {
                return;
              }
              const bounds = pageBoundsRef.current;
              const api = apiRef.current;
              if (!bounds || !api) return;
              const state = api.getAppState() as { width?: number; height?: number };
              if (typeof state.width !== "number" || typeof state.height !== "number") return;
              const inset = measureChromeInsets(
                boardRef.current,
                toolbarHeightRef.current,
                mapChromeHiddenRef.current,
                mobileRef.current,
              );
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
      {interactive && activeTool === "text" && <TextPlaceGhost ref={textPlaceGhostRef} />}
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
      {interactive && <CaptureFeedback ref={captureFeedbackRef} />}

      {interactive && captureArmed && (
        <div
          className="lc-capture-overlay"
          aria-label="Drag to capture a region"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const next = {
              originX: event.clientX,
              originY: event.clientY,
              currentX: event.clientX,
              currentY: event.clientY,
            };
            captureDragRef.current = next;
            setCaptureRegion(next);
          }}
          onPointerMove={(event) => {
            const drag = captureDragRef.current;
            if (!drag) return;
            event.preventDefault();
            const next = { ...drag, currentX: event.clientX, currentY: event.clientY };
            captureDragRef.current = next;
            setCaptureRegion(next);
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            const drag = captureDragRef.current;
            captureDragRef.current = null;
            setCaptureRegion(null);
            if (!drag) {
              setCaptureArmed(false);
              return;
            }
            void finishRegionCapture(
              drag.originX,
              drag.originY,
              event.clientX,
              event.clientY,
            );
          }}
          onPointerCancel={() => {
            captureDragRef.current = null;
            setCaptureArmed(false);
            setCaptureRegion(null);
          }}
        >
          <div className="lc-capture-hint">Drag a rectangle to capture · Esc cancels</div>
          {captureRegion && (() => {
            const board = boardRef.current?.getBoundingClientRect();
            if (!board) return null;
            const left = Math.min(captureRegion.originX, captureRegion.currentX) - board.left;
            const top = Math.min(captureRegion.originY, captureRegion.currentY) - board.top;
            const width = Math.abs(captureRegion.currentX - captureRegion.originX);
            const height = Math.abs(captureRegion.currentY - captureRegion.originY);
            return (
              <div
                className="lc-capture-rect"
                style={{ left, top, width, height }}
              />
            );
          })()}
        </div>
      )}

    </div>
  );
});

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

/**
 * A page with a nib on it — the toolbar toggle, same 24-grid as the eye.
 */
function AnnotateIcon({ on = false }: { on?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 3h9l4 4v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M7.5 16.8 14.4 9.9" />
      <path d="M12.7 8.2 15 5.9a1.2 1.2 0 0 1 1.7 1.7l-2.3 2.3z" />
      {on && <path d="M7.5 16.8 6.8 18.5l1.7-.7" />}
    </svg>
  );
}
