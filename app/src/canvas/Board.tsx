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
} from "../templates/whiteboard";
import {
  isReadingColumnFrame,
  regionFrameId,
  regionFramesOf,
  syncRegionLayout,
  type LayoutElement,
} from "../templates/regionLayout";
import { readingColumnWidth } from "../templates/readingColumn";
import {
  contentAABBsInFrame,
  contentBottomInFrame,
  growDrawHeight,
  isDrawPageRegion,
} from "../templates/drawPageGrowth";
import { INK_REGION_GAP, INK_REGION_PAD, inkRegionSplit } from "./inkRegionSplit";
import { recolorTemplateElements } from "../templates/problemBoard";
import { codeFrameHeightForSource, codeLabelReserve } from "../util/solutionPad";
import { MOBILE_REGION_ORDER, REGION_GUTTER, REGION_MIN, REGION_BLURB, REGIONS, STUDENT_REGION_ORDER, type RegionId } from "../templates/regions";
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
import { fetchNextColorHuntPalette } from "../util/colorHunt";
import {
  appendInkPalette,
  currentInkPalette,
  cycleInkPaletteNext,
  cycleInkPalettePrev,
  normalizeInkPaletteHistory,
  seedInkPaletteHistory,
  setInkPaletteSlot,
  type InkPaletteHistory,
} from "../util/inkPaletteHistory";
import {
  provideInkPaletteAdvance,
  provideInkPaletteRetreat,
  publishInkPalette,
  resetInkPaletteBridge,
} from "./inkPaletteBridge";
import { isDarkTheme } from "../theme/appThemes";
import {
  type BoardReadingSize,
} from "../modes/codeFontSize";
import { applyBoardReadingSize } from "../modes/applyBoardReadingSize";
import { defaultLineHeight } from "../modes/textBaseline";
import type { BoardBinaryFile, BoardHandle, ScreenRect, ToolName } from "./BoardHandle";
import {
  captureImage,
  captureStrokes,
  shrinkImageDataURL,
  type SceneElementLike,
} from "./capture";
import { TEXT_FONT_MAX, TEXT_FONT_MIN } from "./FontSizeSlider";
import { applyMetadata, isCoachElement } from "./scene";
import {
  applyPageVisibility,
  clearPageVisibility,
  pageAtViewport,
  pageBounds,
  viewportBand,
  type PageableElement,
} from "./pageView";
import { encodeInkOps } from "./inkCodec";
import { fallbackPageFrames, pageFramesFromPdfSlot, pageIdFromCamera } from "./inkPageIndex";
import { eraserScreenRadius } from "./rasterInk";
import { reanchorInkOps } from "./reanchorInk";
import { EraserBrush, type EraserBrushHandle } from "./EraserBrush";
import {
  ANNOUNCE_HOLD_MS,
  ModeIndicator,
  type ModeIndicatorHandle,
} from "./ModeIndicator";
import { PadTitle, type PadTitleHandle } from "./PadTitle";
import { PageIndicator, type PageIndicatorHandle } from "./PageIndicator";
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
import {
  INK_OVERDRAW_FRACTION,
  OVERDRAW_REBASE_HEADROOM,
  panDelta,
} from "./panOffset";
import {
  onSelectionGestureClaimed,
  selectionOwnsGesture,
  onDocScrollRequest,
  setDocCameraLive,
  pointerInSubMark,
} from "./docSelectionGesture";
import {
  DOC_PAGE_SELECTOR,
  horizontalScrollHost,
  horizontalScrollHostsIn,
  scrollHostAtPoint,
  scrollHostLookupFromSlot,
  slotCssPerScene,
} from "./scrollHost";
import { SELECT_HOLD_SLOP_PX } from "../util/gesture";
import {
  applyGestureExclusions,
  edgeStrips,
  setDrawingImmersive,
} from "../util/gestureExclusion";
import { BoardToolbar } from "./BoardToolbar";
import { InkPresetEditor } from "./InkPresetEditor";
import { InkToolWheel } from "./InkToolWheel";
import { ScrollBackHold } from "./ScrollBackHold";
import {
  isDeletableElement,
  selectionBounds,
  trashAnchor,
  withLiveTrashEls,
  type TrashEl,
} from "./selectionTrash";
import {
  CHROME_IDLE_MS,
  chromeModeLabel,
  chromeVisibility,
  loadChromeMode,
  nextChromeMode,
  saveChromeMode,
  type ChromeMode,
} from "../util/chromeVisibility";
import {
  CHROME_WAKE_EVENT,
  loadChromeWakeMarker,
  loadChromeWakeTint,
  type ChromeWakeMarker,
  type ChromeWakeTint,
} from "../util/chromeWakePref";
import {
  linedPaperLabel,
  linedPaperScreenPx,
  loadLinedPaperMode,
  nextLinedPaperMode,
  saveLinedPaperMode,
  type LinedPaperMode,
} from "../util/linedPaperPref";
import { loadInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadInkPressureClip } from "../util/inkPressureClip";
import { loadInkSmoothing, loadInkSmoothingMode } from "../util/inkSmoothingPref";
import {
  INK_SPEED_BLOT_BLEND_EVENT,
  loadInkSpeed,
  loadInkSpeedBlotBlend,
} from "../util/inkSpeedPref";
import {
  INK_BOLDNESS_EVENT,
  loadInkBoldness,
} from "../util/inkBoldnessPref";
import {
  ERASER_PARTIAL_EVENT,
  loadEraserPartial,
} from "../util/eraserPartialPref";
import {
  captureInserts,
  captureWritesFile,
  describeCaptureResult,
  loadCaptureMode,
  type CaptureMode,
  loadCaptureCountdown,
  saveCaptureToDevice,
} from "../util/capturePrefs";
import { CaptureFeedback, type CaptureFeedbackHandle } from "./CaptureFeedback";
import { loadInkToolPrefs, saveInkToolPrefs } from "../util/inkToolPrefs";
import {
  applyWedge,
  duplicateWedge,
  isEraserWedge,
  kindFromTool,
  loadInkToolPresets,
  saveInkToolPresets,
  saveWedge,
  toolFromKind,
  wedgeAt,
} from "../util/inkToolPresets";
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
import {
  compositePageLayers,
  resolveExportPaperColor,
  type PageExportLayers,
} from "./exportPageComposite";

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
 * Image pixels per scene unit for a capture the reader is going to keep.
 *
 * A screenshot taken by the tablet is in *device* pixels: a 2x display writes
 * two of them per CSS pixel. Excalidraw's export defaults to one, so the
 * board's own capture of a page came out at half the linear resolution of the
 * system screenshot of the same page — legible on its own and visibly softer
 * the moment the two sit side by side, which is what "should be identical"
 * means here.
 *
 * Rounded, because a fractional ratio buys resampling rather than detail, and
 * capped at 3 so a high-density phone does not turn one page into a canvas the
 * browser refuses. `clampExportScale` still bounds the far end.
 */
function deviceExportScale(): number {
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

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
function paintExportInk(
  inkCtx: CanvasRenderingContext2D,
  ops: readonly InkOp[],
  origin: { x: number; y: number },
  drawScale: number,
  pageLayers: PageExportLayers | null,
): void {
  const hosts = scrollHostLookupFromSlot(pageLayers?.contentSlot, pageLayers?.pageBounds);
  const hostZoom = slotCssPerScene(pageLayers?.contentSlot, pageLayers?.pageBounds);
  paintInkAtScale(inkCtx, ops, origin, drawScale, hosts, hostZoom);
}

async function exportBoardBlob(
  api: ExcalidrawApi,
  ops: readonly InkOp[],
  /**
   * Pixels per scene unit. One — Excalidraw's default — for anything that is
   * about to be downscaled for the coach; {@link deviceExportScale} for a file
   * the reader keeps. The ink composite reads the scale back off the canvas
   * Excalidraw returns, so setting it here is enough for both layers.
   */
  exportScale = 1,
  pageLayers: PageExportLayers | null = null,
): Promise<Blob> {
  const elements = api.getSceneElements();
  const appState = { ...(api.getAppState() as object), exportScale } as Record<string, unknown>;
  const files = api.getFiles();
  const paper = resolveExportPaperColor(
    typeof appState.viewBackgroundColor === "string"
      ? appState.viewBackgroundColor
      : null,
    pageLayers?.paperColor ?? "#ffffff",
  );
  const exportAppState = {
    ...appState,
    exportBackground: true,
    viewBackgroundColor: paper,
  };
  const plain = () =>
    exportToBlob({
      elements: elements as never,
      appState: exportAppState as never,
      files: files as never,
      mimeType: "image/png",
      quality: 0.8,
    });

  const inkBounds = inkOpsBounds(ops);
  const pageBounds = pageLayers?.pageBounds ?? null;
  // Doc pages can be ink-free — still need the HTML/PDF under the transparent
  // Excalidraw frame. Without this, "capture entire" on a clean reading page
  // falls through to plain Excalidraw and comes back black.
  if (!inkBounds && !pageBounds) return plain();
  // Empty Excalidraw scene must still composite the DOM page when present.
  if (elements.length === 0) {
    if (!pageBounds) return plain();
    const content = unionSceneBounds(pageBounds, inkBounds)!;
    return exportSceneFrameBlob(
      api,
      ops,
      {
        x: content.minX - EXPORT_PADDING,
        y: content.minY - EXPORT_PADDING,
        width: content.maxX - content.minX + 2 * EXPORT_PADDING,
        height: content.maxY - content.minY + 2 * EXPORT_PADDING,
      },
      exportScale,
      pageLayers,
    );
  }

  const board = await exportToCanvas({
    elements: elements as never,
    appState: exportAppState as never,
    files: files as never,
    exportPadding: 0,
  });
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  const boardBounds: SceneBounds = { minX, minY, maxX, maxY };
  // Also the check that the export really did land on those bounds: an
  // unhonoured padding skews the two axes apart on any non-square board.
  const scale = exportScaleFrom(board.width, board.height, boardBounds);
  if (scale === null) {
    if (pageBounds) {
      const content = unionSceneBounds(pageBounds, inkBounds)!;
      return exportSceneFrameBlob(
        api,
        ops,
        {
          x: content.minX - EXPORT_PADDING,
          y: content.minY - EXPORT_PADDING,
          width: content.maxX - content.minX + 2 * EXPORT_PADDING,
          height: content.maxY - content.minY + 2 * EXPORT_PADDING,
        },
        exportScale,
        pageLayers,
      );
    }
    return plain();
  }

  const content = unionSceneBounds(
    boardBounds,
    unionSceneBounds(inkBounds, pageBounds),
  )!;
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
  paintExportInk(inkCtx, ops, { x: bounds.minX, y: bounds.minY }, drawScale, pageLayers);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return plain();
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  await compositePageLayers(ctx, bounds, drawScale, pageLayers);
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
  /** See {@link exportBoardBlob}. */
  exportScale = 1,
  pageLayers: PageExportLayers | null = null,
): Promise<Blob> {
  const appState = { ...(api.getAppState() as object), exportScale } as Record<string, unknown>;
  const files = api.getFiles();
  const paper = resolveExportPaperColor(
    (appState as { viewBackgroundColor?: string }).viewBackgroundColor,
    pageLayers?.paperColor ?? "#ffffff",
  );
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
        viewBackgroundColor: paper,
      } as never,
      files: files as never,
      mimeType: "image/png",
      quality: 0.7,
      exportPadding: 16,
    });

  if (elements.length === 0) {
    if (pageLayers?.pageBounds) {
      return exportSceneFrameBlob(api, ops, frame, exportScale, pageLayers);
    }
    return plain();
  }

  const board = await exportToCanvas({
    elements: elements as never,
    appState: {
      ...(appState as object),
      exportBackground: true,
      viewBackgroundColor: paper,
    } as never,
    files: files as never,
    exportPadding: 0,
  });
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  const boardBounds: SceneBounds = { minX, minY, maxX, maxY };
  const scale = exportScaleFrom(board.width, board.height, boardBounds);
  if (scale === null) return plain();
  if (regionOps.length === 0 && !pageLayers?.pageBounds) return plain();

  const content = unionSceneBounds(
    boardBounds,
    unionSceneBounds(inkOpsBounds(regionOps), pageLayers?.pageBounds ?? null),
  )!;
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
  paintExportInk(inkCtx, regionOps, { x: bounds.minX, y: bounds.minY }, drawScale, pageLayers);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return plain();
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  await compositePageLayers(ctx, bounds, drawScale, pageLayers);
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
  /** See {@link exportBoardBlob}. Sets the composite scale here, not just Excalidraw's. */
  exportScale = 2,
  pageLayers: PageExportLayers | null = null,
): Promise<Blob> {
  const appState = { ...(api.getAppState() as object), exportScale } as Record<string, unknown>;
  const files = api.getFiles();
  const all = api.getSceneElements() as SceneElementLike[];
  const paper = resolveExportPaperColor(
    (appState as { viewBackgroundColor?: string }).viewBackgroundColor,
    pageLayers?.paperColor ?? "#ffffff",
  );
  const bounds: SceneBounds = {
    minX: frame.x,
    minY: frame.y,
    maxX: frame.x + frame.width,
    maxY: frame.y + frame.height,
  };
  // Was a flat 2, which happened to match a 2x tablet and was wrong on
  // everything else — half resolution on a 3x phone, double on a 1x desktop.
  const drawScale = clampExportScale(exportScale, bounds);
  const width = Math.max(1, Math.round(frame.width * drawScale));
  const height = Math.max(1, Math.round(frame.height * drawScale));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) {
    return new Blob([], { type: "image/png" });
  }
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  await compositePageLayers(ctx, bounds, drawScale, pageLayers);

  if (all.length > 0) {
    const board = await exportToCanvas({
      elements: all as never,
      appState: {
        ...(appState as object),
        exportBackground: true,
        viewBackgroundColor: paper,
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
      paintExportInk(inkCtx, regionOps, { x: bounds.minX, y: bounds.minY }, drawScale, pageLayers);
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

function boardViewBackground(transparent: boolean, themeBackground: string): string {
  /*
   * Transparent must win when HTML (statement / md-ink) sits under the canvas —
   * an opaque fill would hide that layer. The paper behind it comes from
   * `.lc-board-doc-paper` / `.lc-md-ink-paper`, which now read `--bg` too.
   *
   * There used to be a third case: document pages were pinned to `#0a0a0b`
   * whatever the theme said. That is Carbon's background and only Carbon's, so
   * choosing any other theme left the page black — the theme looked broken
   * rather than partly applied. Carbon still comes out black because that is
   * what its background index holds.
   */
  if (transparent) return "transparent";
  return themeBackground;
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

/** Tools that put marks on the page — the ones annotate mode exists for. */
const DRAWING_TOOLS = new Set<ToolName>([
  "freedraw",
  "highlighter",
  "eraser",
  "text",
  "rectangle",
  "ellipse",
  "arrow",
]);

function isLinearElementType(type: string | undefined): boolean {
  return type === "arrow" || type === "line";
}

/**
 * Excalidraw paints the midpoint bend handle only while `selectedLinearElement`
 * matches the selected arrow/line. `editingLinearElement` is the other field —
 * that one is the tap-to-add-bends trap we keep closed.
 */
function linearEditorState(element: { id: string; elbowed?: boolean }) {
  return {
    elementId: element.id,
    selectedPointsIndices: null,
    isDragging: false,
    lastUncommittedPoint: null,
    pointerOffset: { x: 0, y: 0 },
    startBindingElement: "keep" as const,
    endBindingElement: "keep" as const,
    hoverPointIndex: -1,
    segmentMidPointHoveredCoords: null,
    elbowed: Boolean(element.elbowed),
    pointerDownState: {
      prevSelectedPointsIndices: null,
      lastClickedPoint: -1,
      lastClickedIsEndPoint: false,
      origin: null,
      segmentMidpoint: { value: null, index: null, added: false },
    },
  };
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 1.75;
const ZOOM_STEP = 1.15;
/** Button zoom animation — retargets smoothly on repeat / hold. */
const ZOOM_ANIM_MS = 220;
/** Hand-tool pan inertia — exponential friction per ms (coast after flick). */
const PAN_FRICTION = 0.0045;
/**
 * Coast after a flick. Flip false to isolate finger-drag scroll in profiles
 * (no `Board.step` inertia rAF). End-state of the scroll-perf pass keeps this
 * true — ride-only mid-gesture makes coast cheap again.
 */
const PAN_INERTIA_ENABLED = true;
/** Minimum scroll speed (scene units/ms) to coast after a flick. */
const PAN_FLICK_MIN = 0.035;
/** Stop coasting below this scroll speed. */
const PAN_REST_SPEED = 0.02;
/** Px before a mouse press-during-glide becomes a new drag (touch arms immediately). */
const PAN_DRAG_THRESHOLD_PX = 3;
/** Finger/wheel travel multiplier — 1:1 felt sluggish vs Obsidian. */
const SCROLL_TOUCH_GAIN = 1.85;
const SCROLL_WHEEL_GAIN = 1.55;

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
   * Desktop pager focus — which region capture / fit should target when
   * {@link mobileRegion} is null and the whole column is visible.
   */
  focusRegion?: string | null;
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
   * The page is prose the reader may pick quotes out of.
   *
   * Flips {@link pageContent} from decoration to a hit-testable surface in
   * Scroll mode, which is what lets a hold land on a word at all — see
   * `DocSelectionLayer`. Annotate mode drops back to `pointer-events: none`
   * whatever this says, because there the pen owns the surface and a stray
   * hit-test on the paper would take a stroke away from the ink layer.
   */
  selectableContent?: boolean;
  /**
   * Handed the layer that footnote markers paint into, once it exists.
   *
   * The markers ride the page but must sit over the ink, so they live in their
   * own transformed slot rather than inside the paper — see
   * {@link marksSlotNodeRef}. The document layer portals into whatever this
   * gives it.
   */
  onMarksSlot?: (node: HTMLElement | null) => void;
  /**
   * The highlighter is on — the document layer takes the pointer, not the pen.
   *
   * Reported up because the mark it makes belongs to the document rather than
   * to the canvas, so the thing that draws it lives above Board.
   */
  onHighlightingChange?: (on: boolean) => void;
  /**
   * Footnote underline / highlight sub-mark tools are armed.
   *
   * Same pointer-events flip as Sweep (`lc-board-highlighting`): mute ink +
   * Excalidraw so DocSelectionLayer's character-range path can receive drags
   * while Annotate is otherwise on.
   */
  textMarkSelecting?: boolean;
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
   * Monaco solution height in scene units — sizes the code region frame only.
   *
   * Kept separate from {@link pageContentHeight} so statement / md-ink paper
   * never steals the code page's grow path (and the other way round).
   */
  codeContentHeight?: number | null;
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
   * Carbon OLED paper (`graphite` / `#0a0a0b`) regardless of chrome theme.
   * Used for md-ink, statement, scratchpad, and the code page.
   */
  docPaper?: boolean;
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
  /** Pin the mobile coach sheet against drag gestures. */
  sheetDragLocked?: boolean;
  onToggleSheetLock?: () => void;
  /**
   * PDF page-preview filmstrip. Only passed for a stacked PDF — EPUB and
   * markdown are one flowing document and have nothing to thumbnail.
   */
  pageFilm?: { open: boolean; onToggle: () => void } | null;
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
    focusRegion = null,
    bottomCenter = null,
    pageTitle = null,
    pageContent = null,
    selectableContent = false,
    onMarksSlot,
    onHighlightingChange,
    textMarkSelecting = false,
    pageContentHeight = null,
    codeContentHeight = null,
    transparentCanvas = false,
    docPaper = false,
    annotateToggle = true,
    onAnnotateCodeChange,
    linedPaperToggle = false,
    coachFold = null,
    sheetDragLocked = false,
    onToggleSheetLock,
    pageFilm = null,
  },
  ref,
) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  // Reading mode is the resting state, and reading mode is the hand — a board
  // that starts on `selection` answers the first finger drag with a rubber band.
  const [activeTool, setActiveTool] = useState<ToolName>("hand");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  /** Plain prose vs monospace “code note” for the Text tool. */
  const [textMode, setTextMode] = useState<"plain" | "code">("plain");
  const textModeRef = useRef(textMode);
  textModeRef.current = textMode;
  const inkPrefsRef = useRef(loadInkToolPrefs());
  const [presetStore, setPresetStore] = useState(() => loadInkToolPresets());
  const presetStoreRef = useRef(presetStore);
  presetStoreRef.current = presetStore;
  const [inkWheel, setInkWheel] = useState<
    { x: number; y: number } | "canvas" | null
  >(null);
  const [presetEditor, setPresetEditor] = useState<{
    kind: "pen" | "highlighter" | "eraser";
    index: number;
    from: DOMRect;
  } | null>(null);
  const [wheelPeek, setWheelPeek] = useState(false);
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
  const [straightInk, setStraightInk] = useState(() => inkPrefsRef.current.straightInk);
  const [inkSpeed, setInkSpeed] = useState(() => loadInkSpeed());
  const [inkSpeedBlotBlend, setInkSpeedBlotBlend] = useState(() =>
    loadInkSpeedBlotBlend(),
  );
  const [inkBoldness, setInkBoldness] = useState(() => loadInkBoldness());
  const [eraserPartial, setEraserPartial] = useState(() => loadEraserPartial());
  const [stampTrash, setStampTrash] = useState<{
    ids: string[];
  } | null>(null);
  const stampTrashNodeRef = useRef<HTMLButtonElement | null>(null);
  const stampTrashPosRef = useRef<{ left: number; top: number } | null>(null);
  const syncStampTrashRef = useRef<() => void>(() => {});
  const attachStampTrash = useCallback((node: HTMLButtonElement | null) => {
    stampTrashNodeRef.current = node;
    const pos = stampTrashPosRef.current;
    if (node && pos) {
      node.style.left = `${pos.left}px`;
      node.style.top = `${pos.top}px`;
    }
  }, []);
  /**
   * Markdown content slot — width is React state (rare); left/top/zoom are
   * written to the DOM node so a scroll frame does not re-render Board.
   * Same class of fix as the zoom pill (camera perf pass).
   */
  const contentSlotNodeRef = useRef<HTMLDivElement | null>(null);
  /**
   * A second slot, in the same place as the content slot but over the ink.
   *
   * Footnote markers are chrome *about* the page rather than part of it, so
   * they belong above everything the page and the pen put down. They cannot
   * simply be raised inside the content slot — that slot is opaque paper and
   * lifting it would bury the ink — so they get their own transformed layer,
   * kept in step with the content slot's, and the marks portal into it.
   */
  const marksSlotNodeRef = useRef<HTMLDivElement | null>(null);
  /**
   * Stable, because an inline ref callback is a new function every render —
   * React would detach and re-attach the node each time, which remounts
   * anything portalled into it and restarts its entry animation forever.
   */
  const onMarksSlotRef = useRef(onMarksSlot);
  onMarksSlotRef.current = onMarksSlot;
  const attachMarksSlot = useCallback((node: HTMLDivElement | null) => {
    marksSlotNodeRef.current = node;
    // Mirror whatever the content slot is showing right now, so a remount does
    // not leave the marks a frame behind the page.
    const from = contentSlotNodeRef.current;
    if (node && from) node.style.transform = from.style.transform;
    onMarksSlotRef.current?.(node);
  }, []);
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
  const docPaperRef = useRef(docPaper);
  docPaperRef.current = docPaper;
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
  /** Highlighter mode — see `onHighlightingChange`. Annotate-only. */
  const [highlighting, setHighlighting] = useState(false);
  const highlightingRef = useRef(highlighting);
  highlightingRef.current = highlighting;
  const annotateCodeRef = useRef(annotateCode);
  annotateCodeRef.current = annotateCode;
  /**
   * Ink colour-wheel history for this annotation (saved on the board blob).
   */
  const [inkPaletteHistory, setInkPaletteHistory] = useState<InkPaletteHistory>(() =>
    seedInkPaletteHistory(themeId),
  );
  const inkPaletteHistoryRef = useRef(inkPaletteHistory);
  inkPaletteHistoryRef.current = inkPaletteHistory;
  const inkPaletteFetchRef = useRef(false);
  const inkPalette = useMemo(
    () => currentInkPalette(inkPaletteHistory),
    [inkPaletteHistory],
  );
  const applyInkPaletteHistory = useCallback(
    (next: InkPaletteHistory) => {
      setInkPaletteHistory(next);
      const palette = currentInkPalette(next);
      const ink = resolveInkColor(themeId, inkColorRef.current, palette);
      setInkColor(ink);
      const prefs = { ...inkPrefsRef.current, inkColor: ink };
      inkPrefsRef.current = prefs;
      saveInkToolPrefs(prefs);
      apiRef.current?.updateScene({ appState: { currentItemStrokeColor: ink } });
    },
    [themeId],
  );
  const cycleInkPaletteForward = useCallback(() => {
    const { history, needsFetch } = cycleInkPaletteNext(inkPaletteHistoryRef.current);
    if (!needsFetch) {
      applyInkPaletteHistory(history);
      return;
    }
    if (inkPaletteFetchRef.current) return;
    inkPaletteFetchRef.current = true;
    void fetchNextColorHuntPalette(inkPaletteHistoryRef.current)
      .then((palette) => {
        applyInkPaletteHistory(appendInkPalette(inkPaletteHistoryRef.current, palette));
      })
      .finally(() => {
        inkPaletteFetchRef.current = false;
      });
  }, [applyInkPaletteHistory]);
  const cycleInkPaletteBackward = useCallback(() => {
    applyInkPaletteHistory(cycleInkPalettePrev(inkPaletteHistoryRef.current));
  }, [applyInkPaletteHistory]);
  const applyInkPaletteHistoryRef = useRef(applyInkPaletteHistory);
  applyInkPaletteHistoryRef.current = applyInkPaletteHistory;
  /*
   * Publish the wheel, and lend out its forward cycle.
   *
   * The footnote overview card colours a mark from this palette — the same one
   * the pen draws from, because there is one board and it has one set of
   * colours. See `inkPaletteBridge`.
   */
  useEffect(() => {
    publishInkPalette(inkPaletteHistory);
  }, [inkPaletteHistory]);
  useEffect(() => {
    provideInkPaletteAdvance(cycleInkPaletteForward);
    return () => provideInkPaletteAdvance(null);
  }, [cycleInkPaletteForward]);
  useEffect(() => {
    provideInkPaletteRetreat(cycleInkPaletteBackward);
    return () => provideInkPaletteRetreat(null);
  }, [cycleInkPaletteBackward]);
  useEffect(() => resetInkPaletteBridge, []);
  const [linedPaperMode, setLinedPaperMode] = useState<LinedPaperMode>(loadLinedPaperMode);
  const linedPaperRef = useRef(linedPaperMode);
  linedPaperRef.current = linedPaperMode;
  /**
   * Ruled lines belong on pages you draw on.
   *
   * The statement and the code page are documents: they already have their own
   * typography, and ruling under somebody else's leading puts a line through
   * every third descender. The toggle is hidden on those pages and, because a
   * board can arrive with it already on, the state is gated here as well.
   */
  const linedPaperOn =
    linedPaperMode !== "off" && isDrawPageRegion(mobileRegion ?? null);
  const linedPaperOnRef = useRef(linedPaperOn);
  linedPaperOnRef.current = linedPaperOn;
  /**
   * The board's content width in CSS pixels.
   *
   * The reading column is sized against this, so it has to be the *board's*
   * box rather than the window's: opening the coach panel narrows the board
   * without narrowing the window, and a column measured against the window
   * would then be wider than the space it is fitted into.
   */
  /** Set below — lets the camera fit re-set a column it just re-measured. */
  const reflowReadingTextRef = useRef<(() => void) | null>(null);

  const boardCssWidth = useCallback(() => {
    const box = boardRef.current?.getBoundingClientRect();
    if (box && box.width > 8) return Math.round(box.width);
    return typeof window !== "undefined" ? window.innerWidth : 0;
  }, []);
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
  /*
   * Three settings, not a boolean — see `chromeVisibility`.
   *
   * `awake` is what a tap in the corner turns on and the idle timer turns off
   * again; it means nothing in `visible`, and is the whole of the other two.
   */
  const [chromeMode, setChromeMode] = useState<ChromeMode>(loadChromeMode);
  const [chromeWakeMarker, setChromeWakeMarker] =
    useState<ChromeWakeMarker>(loadChromeWakeMarker);
  const [chromeWakeTint, setChromeWakeTint] =
    useState<ChromeWakeTint>(loadChromeWakeTint);
  const [chromeAwake, setChromeAwake] = useState(true);
  const chromeShown = chromeVisibility(chromeMode, {
    awake: chromeAwake,
    annotating: annotateCode,
  });
  /** Everything downstream still asks the one question it always asked. */
  const mapChromeHidden = !chromeShown.chrome;
  const mapChromeHiddenRef = useRef(mapChromeHidden);
  mapChromeHiddenRef.current = mapChromeHidden;
  const chromeWakeClass = [
    "lc-chrome-wake",
    "lc-tip-target",
    `is-${chromeWakeMarker}`,
    chromeWakeTint === "color" ? "is-tint" : "",
  ]
    .filter(Boolean)
    .join(" ");

  /*
   * The idle timer, and the tap that restarts it.
   *
   * `chromeWakeGen` exists so a wake while already awake still re-arms the
   * timer — `setChromeAwake(true)` alone is a no-op when the flag is true, and
   * annotate / toolbar taps would otherwise leave the old countdown running.
   */
  const [chromeWakeGen, setChromeWakeGen] = useState(0);
  const wakeChrome = useCallback(() => {
    setChromeAwake(true);
    setChromeWakeGen((n) => n + 1);
  }, []);
  // Read from a native listener installed once — see the tap-to-wake guard.
  const wakeChromeRef = useRef(wakeChrome);
  wakeChromeRef.current = wakeChrome;
  /*
   * Left-corner peek: same smear as the eye, but it only brings back the
   * annotate / scroll toggle. Independent of `chromeAwake` so a tap there
   * does not also raise Recentre / theme / the eye.
   */
  const [annotatePeek, setAnnotatePeek] = useState(false);
  const [annotatePeekGen, setAnnotatePeekGen] = useState(0);
  const peekAnnotate = useCallback(() => {
    setAnnotatePeek(true);
    setAnnotatePeekGen((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!annotatePeek) return;
    const timer = window.setTimeout(() => setAnnotatePeek(false), CHROME_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [annotatePeek, annotatePeekGen]);
  useEffect(() => {
    if (chromeShown.chrome) setAnnotatePeek(false);
  }, [chromeShown.chrome]);
  useEffect(() => {
    if (chromeMode === "visible" || !chromeAwake) return;
    const timer = window.setTimeout(() => setChromeAwake(false), CHROME_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [chromeMode, chromeAwake, chromeWakeGen]);
  useEffect(() => {
    saveChromeMode(chromeMode);
    // A new mode always starts shown: cycling to "hidden" and having the eye
    // vanish under the finger that was tapping it is how you lose the control
    // you were using.
    setChromeAwake(true);
    setChromeWakeGen((n) => n + 1);
  }, [chromeMode]);
  const [pressureSensitive, setPressureSensitiveState] = useState(
    () => inkPrefsRef.current.pressureSensitive,
  );
  const eraserBrushRef = useRef<EraserBrushHandle | null>(null);
  const modeIndicatorRef = useRef<ModeIndicatorHandle | null>(null);
  const padTitleRef = useRef<PadTitleHandle | null>(null);
  const pageIndicatorRef = useRef<PageIndicatorHandle | null>(null);
  /** Last page named to the reader, so the pill fires on arrival only. */
  const lastNamedPageRef = useRef<RegionId | null>(null);
  /** Camera the page was last read from — skips the scene walk when still. */
  const lastPageCameraRef = useRef<{ scrollY: number; zoom: number } | null>(null);
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
  /** True while commitVisualScroll's updateScene is in flight — skip re-clamp. */
  const committingScrollRef = useRef(false);
  /** Hand-tool pan: track velocity from scroll deltas for flick inertia. */
  const handPanningRef = useRef(false);
  const panVelocityRef = useRef({ x: 0, y: 0 });
  const lastPanScrollRef = useRef({ x: 0, y: 0, t: 0 });
  const inertiaFrameRef = useRef(0);
  /**
   * Vertical-only drag we own. Excalidraw's hand pans in 2D; reading pages
   * must not. Capture phase + our own scrollY updates keep the column pinned.
   */
  const panDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startScrollY: number;
    lastClientY: number;
    lastT: number;
    armed: boolean;
    /** Code dock: defer arming so taps still focus Monaco. */
    codeDock: boolean;
    codeDockEl: Element | null;
    /** Arming (and with it `preventDefault` and capture) waited for a direction. */
    deferred: boolean;
    /**
     * Hold-to-select may still be pending under this finger.
     *
     * Arming pan / nested `scrollLeft` must wait for {@link SELECT_HOLD_SLOP_PX},
     * matching DocSelectionLayer — a 3px sideways twitch used to rubber-band a
     * wide `pre` and steal the gesture before the hold could claim it.
     */
    selectableDoc: boolean;
    /**
     * Wide codeblock under the finger.
     *
     * Same deal as the code dock: arming is deferred until the gesture says
     * which way it is going. Mostly sideways scrolls the block, mostly down
     * pans the page — the axis decides the owner, once, and it keeps it.
     */
    sideScroll: HTMLElement | null;
    sideScrollActive: boolean;
    sideScrollAnchorX: number;
    sideScrollStart: number;
    /** Zoom frozen for the drag — avoid `getAppState` / `readScroll` per move. */
    zoom: number;
  } | null>(null);
  /**
   * Live camera while reading-scroll is in flight.
   *
   * `updateScene` every pointer/wheel frame is what caps us at ~30fps — Excalidraw
   * reconciles a full scene. During a gesture we drive markdown + ink from this
   * ref and commit scroll to Excalidraw once on settle (Obsidian-style).
   */
  const liveCameraRef = useRef<{
    scrollX: number;
    scrollY: number;
    zoom: number;
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    live: boolean;
  } | null>(null);
  /**
   * Excalidraw scroll the layers were last painted for during a live gesture.
   * Updated on the first live sample and after each mid-gesture rebase — so
   * `applyVisualScrollNow` can skip `getAppState` on every coalesced frame.
   */
  const committedPanCameraRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 });
  const pendingVisualScrollRef = useRef<{ scrollX: number; scrollY: number } | null>(null);
  const visualScrollRafRef = useRef(0);
  const slotReportFrameRef = useRef(0);
  /**
   * Wheel / scroll bursts must pin ink tiles the same way a pan does.
   * Without this, every scroll frame paid full raster budget (camera perf).
   */
  const cameraMotionTimerRef = useRef(0);
  const cameraMotionActiveRef = useRef(false);
  const applyVisualScrollNowRef = useRef<(scrollX: number, scrollY: number) => void>(() => {});
  const scheduleVisualScrollRef = useRef<(scrollX: number, scrollY: number) => void>(() => {});
  const flushVisualScrollRef = useRef<() => void>(() => {});
  const commitVisualScrollRef = useRef<() => void>(() => {});
  const rebaseVisualScrollRef = useRef<() => void>(() => {});

  /**
   * How far the page has been dragged from the camera everything was painted at.
   *
   * Reading scroll leaves Excalidraw's camera alone (see `applyVisualScrollNow`),
   * so the ink bitmap, Excalidraw's own canvases, the lined paper and the page
   * title are all still correct *relative to the page* and wrong only by this
   * translation. Writing `translate3d` on those few nodes (not a custom property
   * on the board root) keeps the compositor cheap — `--lc-pan-*` on `.lc-board`
   * invalidated style for the whole markdown subtree every sample.
   */
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const panRideNodesRef = useRef<HTMLElement[]>([]);

  const refreshPanRideNodes = useCallback(() => {
    const root = boardRef.current;
    if (!root) {
      panRideNodesRef.current = [];
      return;
    }
    const nodes: HTMLElement[] = [];
    root.querySelectorAll("canvas.excalidraw__canvas").forEach((el) => {
      if (el instanceof HTMLElement) nodes.push(el);
    });
    if (linedSlotNodeRef.current) nodes.push(linedSlotNodeRef.current);
    if (titleSlotNodeRef.current) nodes.push(titleSlotNodeRef.current);
    panRideNodesRef.current = nodes;
  }, []);

  const ensurePanRideNodes = useCallback(() => {
    const cached = panRideNodesRef.current;
    if (cached.length === 0 || cached.some((node) => !node.isConnected)) {
      refreshPanRideNodes();
    }
    return panRideNodesRef.current;
  }, [refreshPanRideNodes]);

  const setPagePanOffset = useCallback(
    (dx: number, dy: number) => {
      const current = panOffsetRef.current;
      if (current.x === dx && current.y === dy) return;
      panOffsetRef.current = { x: dx, y: dy };
      const next =
        dx === 0 && dy === 0 ? "" : `translate3d(${dx}px, ${dy}px, 0)`;
      for (const node of ensurePanRideNodes()) {
        if (node.style.transform !== next) node.style.transform = next;
      }
    },
    [ensurePanRideNodes],
  );

  const setPagePanOffsetRef = useRef(setPagePanOffset);
  setPagePanOffsetRef.current = setPagePanOffset;

  /** Put every layer back on its painted coordinates. */
  const clearPanOffsets = useCallback(() => {
    setPagePanOffset(0, 0);
    rasterInkRef.current?.setPanOffset(null);
  }, [setPagePanOffset]);
  const clearPanOffsetsRef = useRef(clearPanOffsets);
  clearPanOffsetsRef.current = clearPanOffsets;

  const pulseCameraMotion = useCallback(() => {
    if (!cameraMotionActiveRef.current) {
      cameraMotionActiveRef.current = true;
      // Gesture open: Excalidraw may have remounted canvases since last ride.
      refreshPanRideNodes();
      rasterInkRef.current?.setCameraMoving(true);
      // Footnote ribbons defer DOM place() while this is true — see DocSelectionLayer.
      setDocCameraLive(true);
    }
    if (cameraMotionTimerRef.current) window.clearTimeout(cameraMotionTimerRef.current);
    cameraMotionTimerRef.current = window.setTimeout(() => {
      cameraMotionTimerRef.current = 0;
      cameraMotionActiveRef.current = false;
      setDocCameraLive(false);
      // Wheel bursts use live camera — paint while live is still true, then
      // commit (clears live on the next frame).
      if (!handPanningRef.current && !inertiaFrameRef.current) {
        rasterInkRef.current?.setCameraMoving(false);
        commitVisualScrollRef.current();
        return;
      }
      rasterInkRef.current?.setCameraMoving(false);
    }, 140);
  }, []);
  const pulseCameraMotionRef = useRef(pulseCameraMotion);
  const readScrollRef = useRef<() => { scrollX: number; scrollY: number; zoom: number }>(
    () => ({ scrollX: 0, scrollY: 0, zoom: 1 }),
  );

  pulseCameraMotionRef.current = pulseCameraMotion;
  const readingSize = readingSizeProp ?? "M";
  const readingSizeRef = useRef(readingSize);
  readingSizeRef.current = readingSize;

  /**
   * Options every `applyBoardReadingSize` call needs.
   *
   * `viewportWidth` is not decoration: the statement's scene font is derived
   * from it, so a call that leaves it out sizes the statement for a phone.
   */
  const readingOpts = useCallback(
    (captureFrom?: BoardReadingSize) => ({
      captureFrom: captureFrom ?? readingSizeRef.current,
      lined: linedPaperOnRef.current,
      viewportWidth: boardCssWidth(),
    }),
    [boardCssWidth],
  );
  const templateRef = useRef<unknown[]>([]);
  const seedSkeletonsRef = useRef<Skeleton[]>([]);
  const scrollUnsubRef = useRef<(() => void) | null>(null);
  const layoutSyncingRef = useRef(false);
  const codeContentHeightRef = useRef<number | null>(null);
  /** Measured statement / md-ink paper height — `runFit` must not shrink below this. */
  const pageContentHeightRef = useRef<number | null>(null);
  /** Viewport page height from the last draw-page fit — drives ink growth steps. */
  const drawBasePageHRef = useRef<number | null>(null);
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
  const focusRegionRef = useRef<string | null>(focusRegion ?? null);
  focusRegionRef.current = focusRegion ?? null;
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

  /*
   * Reconcile what may and may not be grabbed, for boards saved by older builds.
   *
   * Library stamps must stay draggable — older imports may still be locked.
   * Page frames must not be: they are scaffolding, and an unlocked one is the
   * whole-note-dragged-off-screen bug (see `buildWhiteboardTemplate`). Boards
   * written before that fix carry `locked: false` on the frame, so opening one
   * would put the trap straight back.
   */
  useEffect(() => {
    if (!interactive) return;
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElements() as Array<{
      locked?: boolean;
      customData?: {
        lcStamp?: boolean;
        lcRegionFrame?: boolean;
        lcScratchFrame?: boolean;
      } | null;
      [key: string]: unknown;
    }>;
    let changed = false;
    const next = current.map((element) => {
      const meta = element.customData;
      if (meta?.lcStamp && element.locked) {
        changed = true;
        return { ...element, locked: false };
      }
      if ((meta?.lcScratchFrame || meta?.lcRegionFrame) && !element.locked) {
        changed = true;
        return { ...element, locked: true };
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
    // Desktop free-scroll: page is null (show all), but the statement HTML still
    // needs constraints bounds so the overlay can ride the camera mid-pan.
    const boundsPage =
      page ?? (pageContentRef.current ? "constraints" : null);

    const bounds = pageBounds(live, boundsPage);
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
    // Committed camera: the title rides a live pan on the shared translate —
    // see the note in `reportLinedSlot`.
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
   * Position is transform-only (translate+scale) so a scroll frame does not
   * reflow the markdown tree. Scene width still uses React because it reflows
   * the column — that path is rare (open / resize), not per-scroll.
   */
  const reportContentSlot = useCallback(() => {
    const api = apiRef.current;
    const node = contentSlotNodeRef.current;
    if (!pageContentRef.current || !api) {
      lastContentSlotRef.current = null;
      return;
    }
    let bounds = pageBoundsRef.current;
    // Desktop / race: pageBoundsRef may lag one frame — measure the open page.
    // Do not hardcode constraints: md-ink uses ANNOTATE_REGION.
    if (!bounds) {
      const live = api.getSceneElements() as unknown as PageableElement[];
      const page = mobileRegionRef.current ?? "constraints";
      const raw = pageBounds(live, page);
      if (raw) {
        const pad = REGION_GUTTER / 2;
        bounds = {
          minX: raw.minX + pad,
          minY: raw.minY + pad,
          maxX: raw.maxX - pad,
          maxY: raw.maxY - pad,
        };
      }
    }
    if (!bounds) {
      lastContentSlotRef.current = null;
      return;
    }
    /*
     * The live camera wins while a gesture owns it.
     *
     * Unlike the ink and the overlays, this slot is not carried by the shared
     * pan translate — `applyVisualScroll` writes its absolute transform every
     * sample. A report that ran mid-gesture off Excalidraw's (deliberately
     * frozen) appState would therefore drag the markdown back to where the
     * gesture started, one frame before the next sample dragged it forward
     * again: the page tearing away from the ink on top of it.
     */
    const live = liveCameraRef.current;
    const state = live?.live
      ? { scrollX: live.scrollX, scrollY: live.scrollY, zoom: { value: live.zoom } }
      : (api.getAppState() as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
        });
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
      /*
       * Translate+scale only — never left/top.
       *
       * Writing left/top every scroll frame reflows the whole markdown tree
       * (long notes = thousands of nodes). Transform stays on the compositor.
       */
      node.style.transform = `translate(${next.left}px, ${next.top}px) scale(${next.zoom})`;
      if (marksSlotNodeRef.current) {
        marksSlotNodeRef.current.style.transform = node.style.transform;
      }
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
    // Forced off when the board unmounts / leaves a problem — no mode toast.
    // Only the toolbar toggle flashes Annotation / Scroll mode.
    if (!annotateToggle && annotateCode) setAnnotateCode(false);
  }, [annotateCode, annotateToggle]);

  useEffect(() => {
    onAnnotateCodeChange?.(annotateCode);
  }, [annotateCode, onAnnotateCodeChange]);

  /** Snapshot nested host scrollLeft under the content slot (annotate toggle). */
  const snapshotHostScroll = useCallback((): Map<HTMLElement, number> => {
    const slot = contentSlotNodeRef.current;
    const out = new Map<HTMLElement, number>();
    if (!slot) return out;
    for (const doc of slot.querySelectorAll(DOC_PAGE_SELECTOR)) {
      for (const host of horizontalScrollHostsIn(doc)) {
        out.set(host, host.scrollLeft);
      }
    }
    return out;
  }, []);

  const restoreHostScroll = useCallback((saved: Map<HTMLElement, number>) => {
    for (const [host, left] of saved) {
      if (host.isConnected) host.scrollLeft = left;
    }
  }, []);

  const toggleAnnotate = useCallback(() => {
    wakeChromeRef.current();
    const saved = snapshotHostScroll();
    setAnnotateCode((current) => {
      const next = !current;
      modeIndicatorRef.current?.show(next ? "Annotation" : "Scroll mode");
      return next;
    });
    // Mode flip changes PE/classes; restore scroll after commit and repaint ink.
    requestAnimationFrame(() => {
      restoreHostScroll(saved);
      rasterInkRef.current?.repaint();
    });
  }, [restoreHostScroll, snapshotHostScroll]);

  // Leaving Annotate puts the pen down and the highlighter with it.
  useEffect(() => {
    if (!annotateCode && highlighting) setHighlighting(false);
  }, [annotateCode, highlighting]);

  /** Annotate PE/class flip can desync host-bound ink — repaint after the mode settles. */
  useEffect(() => {
    if (!interactive) return;
    const id = requestAnimationFrame(() => {
      rasterInkRef.current?.repaint();
    });
    return () => cancelAnimationFrame(id);
  }, [annotateCode, interactive]);

  useEffect(() => {
    onHighlightingChange?.(highlighting);
  }, [highlighting, onHighlightingChange]);

  /*
   * 🔍 and the pen cannot both be armed. Ask-area parks the ink on `hand`
   * (muted by `lc-board-highlighting`); leaving it restores the annotate pen.
   */
  useEffect(() => {
    if (highlighting) {
      setShapesOpen(false);
      setCaptureMenuOpen(false);
      if (activeToolRef.current !== "hand") setActiveToolRef.current("hand");
      return;
    }
    if (annotateCode && activeToolRef.current === "hand") {
      setActiveToolRef.current("freedraw");
    }
  }, [highlighting, annotateCode]);

  /*
   * Entering annotate mode has to pick up a pen.
   *
   * The ink layer only accepts pointers while a drawing tool is active — that
   * is what `pointerEvents: tool ? "auto" : "none"` says. Nothing set one. The
   * toolbar used to be permanently on screen so the writer had chosen the pen
   * long before, which is why every page that had been drawn on once kept
   * working and the code page, which nobody had drawn on, never did: the mode
   * came up with `hand` still selected and the layer stayed transparent to
   * every stroke.
   *
   * Removing the hand tool made it a trap rather than a nuisance — `hand` is no
   * longer reachable from the menu, so a board that started there could not be
   * argued out of it.
   */
  useEffect(() => {
    if (annotateCode) {
      setActiveToolRef.current(
        DRAWING_TOOLS.has(activeToolRef.current) ? activeToolRef.current : "freedraw",
      );
      return;
    }
    /*
     * Leaving annotate is entering reading mode, and reading mode is the hand.
     *
     * Not `selection`: a finger drag on the selection tool draws a rubber band
     * instead of scrolling the page, which on a board with no hand button left
     * is a page you cannot move. The hand tool has no UI any more — it is what
     * the board sits on whenever nobody is marking it.
     */
    setActiveToolRef.current("hand");
  }, [annotateCode]);

  const reportLinedSlot = useCallback(() => {
    /*
     * `linedPaperOn` is the whole gate — see where it is derived.
     *
     * It is false on the code page and on the statement, and for the same
     * reason in both: those pages already have a line grid of their own, at
     * their own pitch, and a second one behind them agrees with neither and
     * beats against the first.
     */
    if (!linedPaperOnRef.current) {
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
    /*
     * Committed camera, deliberately — the rules ride the live pan on an
     * inline translate (see `setPagePanOffset`). Reporting the live camera
     * here as well would apply the gesture twice, and writing `left`/`top` per
     * sample would lay out and repaint this gradient on the main thread at
     * pointer rate, which is exactly what the translate exists to avoid.
     * Mid-gesture the numbers below cannot change, so this early-outs.
     */
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
    // Handwriting rules: fixed screen pitch so a fitted wide draw frame cannot
    // shrink statement-prose spacing into an unwritable grid. This path only
    // runs for draw pages (`linedPaperOn`); statement/code never get here.
    const zoomSafe = Math.max(0.05, zoom);
    const gap = linedPaperScreenPx(linedPaperRef.current);
    if (gap <= 0) {
      if (lastLinedSlotRef.current !== null) {
        lastLinedSlotRef.current = null;
        setLinedSlotOn(false);
      }
      return;
    }
    const pitchScene = gap / zoomSafe;

    let phase = 0;
    // Lock rules from the frame top — draw pages have no statement body grid.
    const firstRulePx = (bounds.minY + pitchScene + scrollY) * zoom;
    const rel = firstRulePx - top;
    phase = ((rel - gap + 1) % gap + gap) % gap;

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

  const maybeGrowDrawFrame = useCallback((): boolean => {
    const api = apiRef.current;
    if (!api || layoutSyncingRef.current) return false;
    const page = mobileRegionRef.current;
    if (!isDrawPageRegion(page)) return false;

    const basePageH = drawBasePageHRef.current;
    if (!basePageH || basePageH < 1) return false;

    const live = api.getSceneElements() as LayoutElement[];
    const frames = regionFramesOf(live);
    let frame =
      typeof page === "string" && page in REGIONS
        ? frames.get(page as RegionId)
        : undefined;
    if (!frame && page) {
      frame = live.find(
        (el) => el.customData?.lcRegionFrame && el.customData?.lcRegion === page,
      );
    }
    if (!frame) return false;

    const ops = rasterInkRef.current?.getOps() ?? [];
    // Same widening as the preview split: the frame's box has to be concrete
    // before anything measures against it.
    const curH = num(frame.height, 0);
    const contentBottomRel = contentBottomInFrame(live, ops, {
      x: frame.x,
      y: frame.y,
      width: num(frame.width, 0),
      height: curH,
      customData: frame.customData ?? undefined,
    });
    const nextH = growDrawHeight({ basePageH, currentH: curH, contentBottomRel });
    if (Math.abs(curH - nextH) <= 1) return false;

    const nextElements = live.map((el) =>
      el.id === frame!.id ? { ...el, height: nextH } : el,
    ) as LayoutElement[];
    const isScratch = typeof page === "string" && page.startsWith("pad-");
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
    syncPageVisibility();
    return true;
  }, [syncPageVisibility]);

  /**
   * Name the page the camera has arrived on, for boards that scroll freely.
   *
   * Paged boards (`mobileRegion` set) fire the same pill from the pager
   * effect — this walk is only the continuous-scroll desktop stack.
   * The agent lane is deliberately not in the running — it sits beside
   * the column rather than below it, and spans the whole stack, so it would win
   * every vertical-overlap test from the first screen to the last.
   */
  const reportPageIndicator = useCallback(() => {
    const api = apiRef.current;
    if (!api || mobileRegionRef.current !== null) return;

    const state = api.getAppState() as {
      scrollY?: number;
      height?: number;
      zoom?: { value?: number };
    };
    const zoom = state.zoom?.value ?? 1;
    const scrollY = state.scrollY ?? 0;
    const height = state.height ?? 0;

    const camera = lastPageCameraRef.current;
    if (camera && camera.scrollY === scrollY && camera.zoom === zoom) return;
    lastPageCameraRef.current = { scrollY, zoom };

    const band = viewportBand(scrollY, zoom, height);
    if (!band) return;
    const elements = api.getSceneElements() as unknown as PageableElement[];
    const page = pageAtViewport(elements, STUDENT_REGION_ORDER, band.top, band.bottom);
    if (!page || page === lastNamedPageRef.current) return;

    lastNamedPageRef.current = page;
    pageIndicatorRef.current?.show(
      REGIONS[page].label,
      STUDENT_REGION_ORDER.indexOf(page),
      STUDENT_REGION_ORDER.length,
      REGION_BLURB[page],
    );
  }, []);

  const runSlotReports = useCallback(() => {
    // Code dock only exists on the code page — skip the scene walk elsewhere.
    const page = mobileRegionRef.current;
    if (page === null || page === "code") reportCodeSlot();
    reportLinedSlot();
    reportTitleSlot();
    reportContentSlot();
    reportPageIndicator();
  }, [
    reportCodeSlot,
    reportContentSlot,
    reportLinedSlot,
    reportPageIndicator,
    reportTitleSlot,
  ]);

  const scheduleSlotReports = useCallback(() => {
    if (slotReportFrameRef.current) return;
    slotReportFrameRef.current = requestAnimationFrame(() => {
      slotReportFrameRef.current = 0;
      runSlotReports();
    });
  }, [runSlotReports]);

  /**
   * End a live pan: drop the translates and put every slot back on absolute
   * coordinates, in one frame.
   *
   * One frame is the whole requirement. The offsets and the slot reports
   * describe the same position two different ways, so a frame that has applied
   * one and not the other shows the page kicked by the length of the gesture —
   * the snap that used to end every flick. Anything already booked for this
   * frame is cancelled so this is the last word on it, and the ink's own
   * repaint (queued by the caller) lands in the same batch.
   */
  const landPanOffset = useCallback(
    (onLanded?: () => void) => {
      if (slotReportFrameRef.current) cancelAnimationFrame(slotReportFrameRef.current);
      slotReportFrameRef.current = requestAnimationFrame(() => {
        slotReportFrameRef.current = 0;
        clearPanOffsetsRef.current();
        runSlotReports();
        onLanded?.();
      });
    },
    [runSlotReports],
  );

  const clampPanScroll = useCallback((scrollX: number, scrollY: number, zoom: number) => {
    const bounds = pageBoundsRef.current;
    const api = apiRef.current;
    if (!bounds || !api) return { scrollX, scrollY };
    /*
     * Mobile paging always clamped. Desktop used to skip clamp entirely, so a
     * reading board could pan into empty beige past the page — Excalidraw then
     * offered "Scroll back to content" and the hold button sat on a dead zone.
     * Clamp whenever we know the open page box (md-ink / region frames).
     */
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

  /*
   * A text selection dragged off the edge asks the page to come to it.
   *
   * Answered here rather than computed by the selection layer, because
   * everything that makes a scroll correct — the zoom, the chrome insets, where
   * the document actually ends — is already in `clampPanScroll`, and a second
   * copy of that arithmetic would be wrong at precisely the top and bottom of
   * the page, which is where a drag off the edge always finishes.
   *
   * Returns the distance granted. At the end of the document that is zero, and
   * the caller stops asking instead of running a frame loop into a wall.
   */
  useEffect(() => {
    onDocScrollRequest((dy) => {
      if (annotateCodeRef.current) return 0;
      const cam = readScrollRef.current();
      // `dy > 0` is "show me what comes next", and Excalidraw's scrollY grows
      // as the content moves *down* — so going forward means subtracting.
      const next = clampPanScroll(cam.scrollX, cam.scrollY - dy, cam.zoom);
      const moved = cam.scrollY - next.scrollY;
      if (Math.abs(moved) < 0.5) return 0;
      pulseCameraMotionRef.current();
      applyVisualScrollNowRef.current(next.scrollX, next.scrollY);
      return moved;
    });
    return () => onDocScrollRequest(null);
  }, [clampPanScroll]);

  const stopPanInertia = useCallback(() => {
    if (inertiaFrameRef.current) {
      cancelAnimationFrame(inertiaFrameRef.current);
      inertiaFrameRef.current = 0;
    }
  }, []);

  /** Reading mode: Excalidraw must be on hand, or finger drag does nothing. */
  const ensureReadingHand = useCallback(() => {
    if (annotateCodeRef.current) return;
    setActiveTool("hand");
    activeToolRef.current = "hand";
    apiRef.current?.setActiveTool({ type: "hand" });
    apiRef.current?.updateScene({
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  /**
   * What the toolbar toggle was accidentally doing: leave annotate, assert hand,
   * refresh page bounds so touch scroll has somewhere to go.
   */
  const armReadingScroll = useCallback(() => {
    setAnnotateCode(false);
    annotateCodeRef.current = false;
    setActiveTool("hand");
    activeToolRef.current = "hand";
    apiRef.current?.setActiveTool({ type: "hand" });
    apiRef.current?.updateScene({
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    syncPageVisibility();
    const state = apiRef.current?.getAppState() as
      | { scrollX?: number; scrollY?: number }
      | undefined;
    if (state && scrollModeRef.current) {
      lockedScrollXRef.current = state.scrollX ?? 0;
    }
    scheduleSlotReports();
  }, [scheduleSlotReports, syncPageVisibility]);

  const persistInkPrefs = useCallback(
    (patch: Partial<{
      penWidth: number;
      eraserWidth: number;
      inkFullness: number;
      pressureSensitive: boolean;
      inkColor: string;
      straightInk: boolean;
    }>) => {
      const next = {
        penWidth: patch.penWidth ?? penStrokeWidth,
        eraserWidth: patch.eraserWidth ?? eraserStrokeWidth,
        inkFullness: patch.inkFullness ?? inkFullness,
        pressureSensitive: patch.pressureSensitive ?? pressureSensitive,
        inkColor: patch.inkColor ?? inkColor,
        straightInk: patch.straightInk ?? straightInk,
      };
      inkPrefsRef.current = next;
      saveInkToolPrefs(next);
    },
    [penStrokeWidth, eraserStrokeWidth, inkFullness, pressureSensitive, inkColor, straightInk],
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

  const setStraightInkOn = useCallback(
    (on: boolean) => {
      setStraightInk(on);
      persistInkPrefs({ straightInk: on });
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

  const syncInkFromPrefs = useCallback(() => {
    const prefs = loadInkToolPrefs();
    inkPrefsRef.current = prefs;
    setPenStrokeWidth(prefs.penWidth);
    setEraserStrokeWidth(prefs.eraserWidth);
    setInkFullnessState(prefs.inkFullness);
    setPressureSensitiveState(prefs.pressureSensitive);
    setStraightInk(prefs.straightInk);
    if (prefs.inkColor) setInkColor(prefs.inkColor);
  }, []);

  const applyInkWedge = useCallback(
    (kind: "pen" | "highlighter" | "eraser", index: number) => {
      const next = applyWedge(presetStoreRef.current, kind, index);
      setPresetStore(next);
      syncInkFromPrefs();
    },
    [syncInkFromPrefs],
  );

  const applyTextModeToAppState = useCallback((mode: "plain" | "code") => {
    apiRef.current?.updateScene({
      appState: {
        currentItemFontFamily: mode === "code" ? FONT_CODE : FONT_UI,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  const setActiveToolRef = useRef<(tool: ToolName) => void>(() => {});
  const setTool = useCallback((tool: ToolName) => {
    // One tool at a time: picking a drawing / select tool drops Ask-area (🔍).
    // `hand` is the parked tool while 🔍 owns the page — do not clear it here.
    if (tool !== "hand") setHighlighting(false);
    if (tool === "freedraw" || tool === "highlighter") {
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
      /*
       * Shape tools stay equipped.
       *
       * Excalidraw drops back to `selection` the moment a shape is placed, so
       * drawing three rectangles was nine gestures: pick the tool, draw, pick
       * it again. `locked` is upstream's own tool-lock and it is the right
       * default here — this is a board you sketch on, and the toolbar is one
       * tap away when you do want to stop.
       */
      const sticky = tool === "rectangle" || tool === "ellipse" || tool === "arrow";
      apiRef.current?.setActiveTool({ type: tool, locked: sticky });
      apiRef.current?.resetCursor?.();
    }

    /*
     * Changing tools is always an exit.
     *
     * A line left open in Excalidraw's point editor keeps taking taps as bends
     * even after the toolbar has moved on, so the escape hatch has to be here
     * as well as on pointerup — picking any other tool is the most obvious way
     * a hand tries to get out of a shape that will not let go.
     */
    apiRef.current?.updateScene({
      appState: { multiElement: null, editingLinearElement: null },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
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
    const kind = kindFromTool(tool);
    if (kind && tool !== activeTool) {
      applyInkWedge(kind, presetStoreRef.current.lastWedge[kind]);
    }
    // Scroll tool: drop any selection. A selected page frame draws animated
    // ants around the whole document and tanks scroll on long pages.
    if (tool === "hand") {
      apiRef.current?.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [activeTool, applyTextModeToAppState, applyInkWedge]);
  setActiveToolRef.current = setTool;

  useEffect(() => {
    const onPresets = () => setPresetStore(loadInkToolPresets());
    window.addEventListener("lc-ink-presets", onPresets);
    return () => window.removeEventListener("lc-ink-presets", onPresets);
  }, []);

  useEffect(() => {
    if (annotateCode) {
      setShapesOpen(false);
      setCaptureMenuOpen(false);
      // Pen is the annotate entry tool — Select is a deliberate second pick.
      setTool("freedraw");
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

  useEffect(() => {
    const onBlotBlend = () => setInkSpeedBlotBlend(loadInkSpeedBlotBlend());
    window.addEventListener(INK_SPEED_BLOT_BLEND_EVENT, onBlotBlend);
    return () =>
      window.removeEventListener(INK_SPEED_BLOT_BLEND_EVENT, onBlotBlend);
  }, []);

  useEffect(() => {
    const onBoldness = () => setInkBoldness(loadInkBoldness());
    window.addEventListener(INK_BOLDNESS_EVENT, onBoldness);
    return () => window.removeEventListener(INK_BOLDNESS_EVENT, onBoldness);
  }, []);

  useEffect(() => {
    const onEraser = () => setEraserPartial(loadEraserPartial());
    window.addEventListener(ERASER_PARTIAL_EVENT, onEraser);
    return () => window.removeEventListener(ERASER_PARTIAL_EVENT, onEraser);
  }, []);

  useEffect(() => {
    const onWake = () => {
      setChromeWakeMarker(loadChromeWakeMarker());
      setChromeWakeTint(loadChromeWakeTint());
    };
    window.addEventListener(CHROME_WAKE_EVENT, onWake);
    return () => window.removeEventListener(CHROME_WAKE_EVENT, onWake);
  }, []);

  const deleteSelection = useCallback(() => {
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
    const live = liveCameraRef.current;
    if (live?.live) {
      return {
        zoom: live.zoom,
        scrollX: live.scrollX,
        scrollY: live.scrollY,
        offsetLeft: live.offsetLeft,
        offsetTop: live.offsetTop,
        width: live.width,
        height: live.height,
      };
    }
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

  /**
   * Nested scroll hosts for host-bound ink — same slot mapping as export so
   * paint keys/bounds match PNG composite.
   */
  const getScrollHosts = useCallback(() => {
    const map = scrollHostLookupFromSlot(
      contentSlotNodeRef.current,
      pageBoundsRef.current,
    );
    if (!map) return [];
    return [...map.entries()].map(([key, host]) => ({
      key,
      scrollLeft: host.scrollLeft,
      bounds: host.bounds,
    }));
  }, []);

  const getPageFrames = useCallback(() => {
    const fromPdf = pageFramesFromPdfSlot(contentSlotNodeRef.current, pageBoundsRef.current);
    if (fromPdf.length > 0) return fromPdf;
    return fallbackPageFrames(pageBoundsRef.current);
  }, []);

  /**
   * Move the page for one scroll sample — no `updateScene`, no reblit.
   *
   * Everything on the board is bound to page coordinates for the duration of
   * the gesture: the markdown slot takes its absolute transform, and the ink,
   * Excalidraw's canvases and the overlays take the delta from the camera they
   * were painted at. That is one compositor translate per layer per frame,
   * against the clear-and-blit of the whole ink layer this used to do — the
   * difference between a coast that costs `Board.step` and one that costs
   * `Board.step` plus a full raster pass.
   */
  const applyVisualScrollNow = useCallback((scrollX: number, scrollY: number) => {
    const api = apiRef.current;
    if (!api) return;
    const prev = liveCameraRef.current;
    let zoom: number;
    let width: number;
    let height: number;
    let offsetLeft: number;
    let offsetTop: number;
    let committedScrollX: number;
    let committedScrollY: number;
    if (prev?.live) {
      zoom = prev.zoom;
      width = prev.width;
      height = prev.height;
      offsetLeft = prev.offsetLeft;
      offsetTop = prev.offsetTop;
      committedScrollX = committedPanCameraRef.current.scrollX;
      committedScrollY = committedPanCameraRef.current.scrollY;
    } else {
      const state = api.getAppState() as {
        zoom?: { value?: number };
        scrollX?: number;
        scrollY?: number;
        offsetLeft?: number;
        offsetTop?: number;
        width?: number;
        height?: number;
      };
      if (typeof state.width !== "number" || typeof state.height !== "number") return;
      zoom = state.zoom?.value ?? 1;
      width = state.width;
      height = state.height;
      offsetLeft = state.offsetLeft ?? 0;
      offsetTop = state.offsetTop ?? 0;
      committedScrollX = state.scrollX ?? 0;
      committedScrollY = state.scrollY ?? 0;
      committedPanCameraRef.current = {
        scrollX: committedScrollX,
        scrollY: committedScrollY,
        zoom,
      };
    }
    liveCameraRef.current = {
      scrollX,
      scrollY,
      zoom,
      width,
      height,
      offsetLeft,
      offsetTop,
      live: true,
    };
    const bounds = pageBoundsRef.current;
    const node = contentSlotNodeRef.current;
    if (bounds && node && pageContentRef.current) {
      const left = (bounds.minX + scrollX) * zoom;
      const top = (bounds.minY + scrollY) * zoom;
      node.style.transform = `translate(${left}px, ${top}px) scale(${zoom})`;
      if (marksSlotNodeRef.current) {
        marksSlotNodeRef.current.style.transform = node.style.transform;
      }
      lastContentSlotRef.current = {
        left,
        top,
        sceneWidth: Math.max(1, bounds.maxX - bounds.minX),
        zoom,
      };
    } else if (!bounds && node && pageContentRef.current && api) {
      // Same desktop fallback as reportContentSlot — live pan must not wait a
      // slot-report frame before the markdown rides.
      const liveEls = api.getSceneElements() as unknown as PageableElement[];
      const page = mobileRegionRef.current ?? "constraints";
      const raw = pageBounds(liveEls, page);
      if (raw) {
        const pad = REGION_GUTTER / 2;
        const fallback = {
          minX: raw.minX + pad,
          minY: raw.minY + pad,
          maxX: raw.maxX - pad,
          maxY: raw.maxY - pad,
        };
        const left = (fallback.minX + scrollX) * zoom;
        const top = (fallback.minY + scrollY) * zoom;
        node.style.transform = `translate(${left}px, ${top}px) scale(${zoom})`;
        if (marksSlotNodeRef.current) {
          marksSlotNodeRef.current.style.transform = node.style.transform;
        }
        lastContentSlotRef.current = {
          left,
          top,
          sceneWidth: Math.max(1, fallback.maxX - fallback.minX),
          zoom,
        };
      }
    }
    pulseCameraMotionRef.current();
    if (stampTrashPosRef.current) syncStampTrashRef.current();

    /*
     * Ride, or rebase.
     *
     * The ink measures the delta against its own last paint and the overlays
     * against Excalidraw's appState — the same camera in the ordinary case, and
     * each one right on its own terms when a mid-gesture repaint has moved one
     * of them. Either can veto: a zoom (no translate expresses a rescale) or a
     * drag past half a viewport (the painted screenful has run out). Rebase
     * then: one `updateScene` + ink reblit, then ride again from zero.
     *
     * Burst guard: while a rebase/commit `updateScene` is in flight, ink's
     * paintedView can lag one rAF — `setPanOffset` keeps failing and must not
     * re-arm another full settle per sample.
     */
    const liveCam = { scrollX, scrollY, zoom };
    const committed = {
      scrollX: committedScrollX,
      scrollY: committedScrollY,
      zoom,
    };
    const delta = panDelta(liveCam, committed, { width, height }, undefined, {
      y: height * INK_OVERDRAW_FRACTION * OVERDRAW_REBASE_HEADROOM,
    });
    const inkRides = rasterInkRef.current?.setPanOffset(liveCam) ?? true;
    if (delta.rebase || !inkRides) {
      if (!committingScrollRef.current) rebaseVisualScrollRef.current();
      return;
    }
    setPagePanOffsetRef.current(delta.dx, delta.dy);
  }, []);

  const flushVisualScroll = useCallback(() => {
    if (visualScrollRafRef.current) {
      cancelAnimationFrame(visualScrollRafRef.current);
      visualScrollRafRef.current = 0;
    }
    const pending = pendingVisualScrollRef.current;
    pendingVisualScrollRef.current = null;
    if (pending) applyVisualScrollNow(pending.scrollX, pending.scrollY);
  }, [applyVisualScrollNow]);

  const scheduleVisualScroll = useCallback(
    (scrollX: number, scrollY: number) => {
      pendingVisualScrollRef.current = { scrollX, scrollY };
      if (visualScrollRafRef.current) return;
      visualScrollRafRef.current = requestAnimationFrame(() => {
        visualScrollRafRef.current = 0;
        const pending = pendingVisualScrollRef.current;
        pendingVisualScrollRef.current = null;
        if (pending) applyVisualScrollNow(pending.scrollX, pending.scrollY);
      });
    },
    [applyVisualScrollNow],
  );

  /**
   * Mid-gesture repaint: adopt the live camera as the painted one and carry on.
   *
   * A translate can only borrow against a screenful that has already been
   * painted, so a long flick has to stop and pay for a real one somewhere. Do
   * it as a normal settle — push the camera into Excalidraw, repaint the ink
   * once, re-report the slots — except that the gesture stays live, so the next
   * sample starts riding again from zero.
   */
  const rebaseVisualScroll = useCallback(() => {
    if (committingScrollRef.current) return;
    // Arm the burst guard before flush: applying a pending sample can still
    // ask for rebase, and must not re-enter while this settle is in flight.
    committingScrollRef.current = true;
    flushVisualScroll();
    const live = liveCameraRef.current;
    const api = apiRef.current;
    if (!live?.live || !api) {
      committingScrollRef.current = false;
      return;
    }
    committedPanCameraRef.current = {
      scrollX: live.scrollX,
      scrollY: live.scrollY,
      zoom: live.zoom,
    };
    api.updateScene({
      appState: { scrollX: live.scrollX, scrollY: live.scrollY },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // Coalesced into this frame's rAF, ahead of `landPanOffset`'s — the ink is
    // repainted for the camera we just committed before the offsets that were
    // standing in for it are dropped.
    rasterInkRef.current?.syncCamera();
    landPanOffset(() => {
      committingScrollRef.current = false;
    });
  }, [flushVisualScroll, landPanOffset]);

  /**
   * Push live camera into Excalidraw once the gesture settles.
   *
   * Keep `live` true through the settle paint. Clearing it before
   * `setCameraMoving(false)` → `commitCamera` made ink fall back to
   * Excalidraw's still-stale appState and flash the pre-flick view (often
   * the top of the page) for one frame when a coast hits the bottom wall.
   */
  const commitVisualScroll = useCallback(() => {
    flushVisualScroll();
    const live = liveCameraRef.current;
    if (!live?.live) {
      // Nothing was riding, but a gesture that never went live (a tap, a tool
      // change) must not leave a stale translate on the board.
      clearPanOffsetsRef.current();
      return;
    }
    committingScrollRef.current = true;
    committedPanCameraRef.current = {
      scrollX: live.scrollX,
      scrollY: live.scrollY,
      zoom: live.zoom,
    };
    apiRef.current?.updateScene({
      appState: { scrollX: live.scrollX, scrollY: live.scrollY },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    landPanOffset(() => {
      committingScrollRef.current = false;
      if (liveCameraRef.current === live) live.live = false;
    });
  }, [flushVisualScroll, landPanOffset]);
  applyVisualScrollNowRef.current = applyVisualScrollNow;
  scheduleVisualScrollRef.current = scheduleVisualScroll;
  flushVisualScrollRef.current = flushVisualScroll;
  commitVisualScrollRef.current = commitVisualScroll;
  rebaseVisualScrollRef.current = rebaseVisualScroll;

  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    /*
     * Gatekeeper (Gemini idea, correct polarity).
     *
     * Annotate OFF → capture-phase hijack: Excalidraw never sees the pointer.
     * Annotate ON  → only hijack when Hand is active (scroll while annotating);
     *                drawing tools pass through to Excalidraw / ink.
     *
     * Gemini's sample flipped this. Reading mode is when we own the gesture.
     */
    const resolveElement = (target: EventTarget | null): Element | null => {
      if (target instanceof Element) return target;
      if (target && typeof (target as Node).parentElement !== "undefined") {
        return (target as Node).parentElement;
      }
      return null;
    };

    const isCodeDockTarget = (target: EventTarget | null) =>
      mobileRegionRef.current === "code" &&
      !annotateCodeRef.current &&
      resolveElement(target)?.closest(".lc-code-dock") != null;

    /** Hit is on selectable prose/code/PDF text — native Selection owns the drag. */
    const pointerOnSelectableText = (
      clientX: number,
      clientY: number,
      target: EventTarget | null,
    ): boolean => {
      const el = resolveElement(target);
      if (!el?.closest(".lc-doc-selectable-body")) return false;
      if (el.closest(".lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm")) return false;
      if (el.closest("img, canvas, svg, video")) return false;
      const caret =
        typeof document.caretRangeFromPoint === "function"
          ? document.caretRangeFromPoint(clientX, clientY)
          : null;
      if (caret?.startContainer?.nodeType === Node.TEXT_NODE) {
        return (caret.startContainer.textContent?.length ?? 0) > 0;
      }
      // PDF text layer spans — caretRangeFromPoint is flaky; trust the layer.
      if (el.closest(".lc-pdf-text, .textLayer")) return true;
      // Inside pre/code but not on a text node → leave for sideScroll / pan.
      if (el.closest("pre, code")) return false;
      return (
        el.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, span, label") != null
      );
    };

    const isScrollSurface = (target: EventTarget | null) => {
      const el = resolveElement(target);
      if (!el) return false;
      /*
       * Chrome painted over the page is not page.
       *
       * The marks slot lives inside `.lc-board`, so a footnote ribbon and the
       * selection's own confirm both looked like bare scroll surface — and the
       * gatekeeper's `stopPropagation()` on pointerdown meant the tap never
       * reached them at all. Not "the handler ran and did nothing": the event
       * stopped at this element, one node above the control, so React's
       * listeners never saw it and no `click` was generated either, because the
       * pointer had been captured by the board. A ribbon tapped while reading
       * was simply dead, which is exactly what it looked like.
       */
      if (
        el.closest(
          ".lc-toolbar, .lc-map-controls, .lc-pager, .lc-stamp-trash, .lc-capture-overlay," +
            " .lc-doc-footnote, .lc-doc-confirm, .lc-doc-sheet, .lc-footnote-overview" +
            ", .lc-footnote-bubble, .lc-scroll-back-hold, .lc-hold-reveal",
        )
      ) {
        return false;
      }
      return el.closest(".lc-board") != null;
    };

    const canOwnScroll = () => {
      // A hold that turned into a text selection has taken this gesture — see
      // docSelectionGesture. The pan may already be armed when the claim lands
      // mid-drag, which is why this is checked on every move and not only at
      // pointerdown.
      if (selectionOwnsGesture()) return false;
      if (!annotateCodeRef.current) return true;
      // Sweep (doc highlighting) must still pan — otherwise the page is stuck.
      if (highlightingRef.current) return true;
      return activeToolRef.current === "hand";
    };

    const armThresholdPx = (drag: { selectableDoc: boolean }) =>
      drag.selectableDoc ? SELECT_HOLD_SLOP_PX : PAN_DRAG_THRESHOLD_PX;

    /**
     * Drop a deferred reading pan the moment selection claims the finger.
     *
     * Without this, a micro-move that armed side-scroll before the hold fired
     * keeps driving `scrollLeft` (or holds capture) through the quote drag.
     */
    const dropPanForSelection = () => {
      const drag = panDragRef.current;
      if (!drag) return;
      if (drag.codeDockEl) {
        drag.codeDockEl.classList.remove("lc-code-dock-scrolling");
      }
      try {
        root.releasePointerCapture(drag.pointerId);
      } catch {
        /* already released */
      }
      panDragRef.current = null;
      handPanningRef.current = false;
      panVelocityRef.current = { x: 0, y: 0 };
      rasterInkRef.current?.setCameraMoving(false);
    };
    onSelectionGestureClaimed(dropPanForSelection);

    // Published so the edge auto-scroll above can read the same camera the pan
    // does — the live one mid-gesture, Excalidraw's between gestures.
    readScrollRef.current = () => readScroll();
    const readScroll = () => {
      const live = liveCameraRef.current;
      if (live?.live) return { scrollX: live.scrollX, scrollY: live.scrollY, zoom: live.zoom };
      const state = apiRef.current?.getAppState() as
        | { scrollX?: number; scrollY?: number; zoom?: { value?: number } }
        | undefined;
      return {
        scrollX: state?.scrollX ?? 0,
        scrollY: state?.scrollY ?? 0,
        zoom: state?.zoom?.value ?? 1,
      };
    };

    const startPanInertia = (_velocityX: number, velocityY: number) => {
      const api = apiRef.current;
      if (!api) return;
      stopPanInertia();
      let velY = velocityY;
      let last = performance.now();
      const cam = readScroll();
      let scrollX = scrollModeRef.current
        ? (lockedScrollXRef.current ?? cam.scrollX)
        : cam.scrollX;
      let scrollY = cam.scrollY;
      const zoom = cam.zoom;
      if (scrollModeRef.current) lockedScrollXRef.current = scrollX;

      const settle = () => {
        inertiaFrameRef.current = 0;
        applyVisualScrollNowRef.current(scrollX, scrollY);
        // Paint while live camera still holds the coast position, then push
        // into Excalidraw. Commit clears live on the next frame.
        rasterInkRef.current?.setCameraMoving(false);
        commitVisualScrollRef.current();
      };

      const step = (now: number) => {
        const dt = Math.min(34, Math.max(1, now - last));
        last = now;
        const wantY = scrollY + velY * dt;
        const clamped = clampPanScroll(scrollX, wantY, zoom);
        const takenY = clamped.scrollY - scrollY;
        const wantedY = wantY - scrollY;
        if (Math.abs(wantedY) > 1e-6) {
          velY *= Math.min(1, Math.max(0, takenY / wantedY));
        }
        scrollY = clamped.scrollY;
        if (scrollModeRef.current && lockedScrollXRef.current !== null) {
          scrollX = lockedScrollXRef.current;
        } else {
          scrollX = clamped.scrollX;
        }
        velY *= Math.exp(-PAN_FRICTION * dt);
        if (Math.abs(velY) < PAN_REST_SPEED) {
          settle();
          return;
        }
        applyVisualScrollNowRef.current(scrollX, scrollY);
        inertiaFrameRef.current = requestAnimationFrame(step);
      };
      rasterInkRef.current?.setCameraMoving(true);
      inertiaFrameRef.current = requestAnimationFrame(step);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!canOwnScroll()) return;
      if (event.button !== 0) return;
      if (!isScrollSurface(event.target)) return;
      /*
       * Armed sub-mark owns the finger inside the open mark. Do not write
       * panDragRef at all — deferred selectable-doc pan would still arm after
       * SELECT_HOLD_SLOP_PX when DocSelectionLayer's band hit misses.
       */
      if (pointerInSubMark(event.clientX, event.clientY)) return;

      // Mouse: down+drag on words is native select. Touch/pen must still pan —
      // Android has no wheel, `touch-action: none` kills native scroll, and an
      // early return here left the statement stuck. Deferred selectable-doc pan
      // below waits SELECT_HOLD_SLOP_PX; a live Selection aborts the arm.
      if (
        event.pointerType === "mouse" &&
        pointerOnSelectableText(event.clientX, event.clientY, event.target)
      ) {
        return;
      }

      const onCodeDock = isCodeDockTarget(event.target);
      const codeDockEl = onCodeDock
        ? resolveElement(event.target)?.closest(".lc-code-dock") ?? null
        : null;
      // A wide codeblock defers the same way the dock does: which axis the
      // gesture turns out to be is what decides who owns it.
      // Geometry hit — annotate lands on the ink canvas, so `event.target` is
      // never inside the doc and `horizontalScrollHost(target)` always misses.
      const sideScroll = onCodeDock
        ? null
        : scrollHostAtPoint(event.clientX, event.clientY) ??
          horizontalScrollHost(event.target);
      /*
       * Selectable prose defers for the same reason, on time rather than axis.
       *
       * Arming the pan immediately (which is what touch normally does, for 1:1
       * tracking) would mean a hold-to-select still built up a pan velocity
       * from the drag, and the page would fling away under the finished quote.
       * On selectable docs the arm threshold matches SELECT_HOLD_SLOP_PX so a
       * sideways twitch cannot rubber-band a wide `pre` before the hold claims.
       */
      const onSelectableDoc =
        !onCodeDock && resolveElement(event.target)?.closest(".lc-doc-selectable") != null;
      const deferred = onCodeDock || sideScroll != null || onSelectableDoc;

      // A finger on a coasting page is a full stop, and where it lands is where
      // the page stays. Killing the loop (rather than raising its friction and
      // letting it run) is also what leaves one writer on the camera: the drag
      // below anchors on `readScroll()`, and a live inertia rAF would otherwise
      // race it into `applyVisualScrollNow` on alternate frames — the page
      // snapping between the touch point and the coast's projected stop.
      flushVisualScrollRef.current();
      stopPanInertia();

      // Code dock: defer preventDefault until pan arms — taps must reach Monaco.
      if (!deferred) {
        event.preventDefault();
        event.stopPropagation();
      }

      handPanningRef.current = true;
      if (!deferred) {
        rasterInkRef.current?.setCameraMoving(true);
      }
      panVelocityRef.current = { x: 0, y: 0 };
      const now = performance.now();
      const cam = readScroll();
      lockedScrollXRef.current = scrollModeRef.current ? cam.scrollX : null;
      lastPanScrollRef.current = { x: cam.scrollX, y: cam.scrollY, t: now };
      // Touch/pen: arm immediately except on code dock (tap-to-edit).
      const touchLike = event.pointerType === "touch" || event.pointerType === "pen";
      panDragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollY: cam.scrollY,
        lastClientY: event.clientY,
        lastT: now,
        armed: deferred ? false : touchLike,
        codeDock: onCodeDock,
        codeDockEl,
        deferred,
        selectableDoc: onSelectableDoc,
        sideScroll,
        sideScrollActive: false,
        sideScrollAnchorX: event.clientX,
        sideScrollStart: sideScroll?.scrollLeft ?? 0,
        zoom: cam.zoom,
      };
      if (!deferred) {
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          /* capture is best-effort on some hosts */
        }
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!handPanningRef.current) return;
      if (!canOwnScroll()) return;
      /*
       * Sub-mark owns the finger once it enters the open mark — even if pan
       * deferred-armed from a down outside the bands.
       */
      if (pointerInSubMark(event.clientX, event.clientY)) {
        dropPanForSelection();
        return;
      }

      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;

      /*
       * A codeblock that has already claimed the gesture keeps it to the end.
       *
       * Scrolling it by hand rather than leaving it to the browser is not
       * belt-and-braces: reading mode sets `touch-action: none` on the board so
       * that our own pan can arm at all, and that intersects with anything a
       * descendant asks for. Nothing native is going to scroll this box.
       */
      if (drag.sideScrollActive && drag.sideScroll) {
        event.preventDefault();
        event.stopPropagation();
        drag.sideScroll.scrollLeft =
          drag.sideScrollStart - (event.clientX - drag.sideScrollAnchorX);
        return;
      }
      if (drag.sideScroll && !drag.armed) {
        // Native select in flight — do not steal the drag into nested scrollLeft.
        const live = window.getSelection();
        if (live && !live.isCollapsed && live.rangeCount > 0) {
          drag.sideScroll = null;
        } else if (Math.hypot(dx, dy) < armThresholdPx(drag)) {
          return;
        } else if (Math.abs(dx) > Math.abs(dy)) {
          drag.sideScrollActive = true;
          // Anchor on the sample that decided it, so the block does not jump
          // by the threshold the moment it takes over.
          drag.sideScrollAnchorX = event.clientX;
          drag.sideScrollStart = drag.sideScroll.scrollLeft;
          // A coast the finger landed on is over, and the page will not move
          // again this gesture — settle it here rather than leaving the board
          // sitting on a translate that no lift is going to come and clear.
          stopPanInertia();
          rasterInkRef.current?.setCameraMoving(false);
          commitVisualScrollRef.current();
          event.preventDefault();
          event.stopPropagation();
          try {
            root.setPointerCapture(event.pointerId);
          } catch {
            /* capture is best-effort on some hosts */
          }
          return;
        } else {
          // Vertical: the page wins, and the block is out of it for this gesture.
          drag.sideScroll = null;
        }
      }

      if (!drag.armed) {
        if (Math.hypot(dx, dy) < armThresholdPx(drag)) return;
        if (drag.selectableDoc) {
          const live = window.getSelection();
          if (live && !live.isCollapsed && live.rangeCount > 0) {
            dropPanForSelection();
            return;
          }
        }
        stopPanInertia();
        const cam = readScroll();
        drag.startScrollY = cam.scrollY;
        drag.startClientY = event.clientY;
        drag.lastClientY = event.clientY;
        drag.lastT = performance.now();
        drag.zoom = cam.zoom;
        drag.armed = true;
        if (drag.deferred) {
          drag.codeDockEl?.classList.add("lc-code-dock-scrolling");
          rasterInkRef.current?.setCameraMoving(true);
          try {
            root.setPointerCapture(event.pointerId);
          } catch {
            /* capture is best-effort on some hosts */
          }
        }
      }

      event.preventDefault();
      event.stopPropagation();

      const zoom = drag.zoom;
      const lockX = lockedScrollXRef.current;
      const nextY =
        drag.startScrollY +
        ((event.clientY - drag.startClientY) / zoom) * SCROLL_TOUCH_GAIN;
      const clamped = clampPanScroll(lockX ?? 0, nextY, zoom);
      const scrollX = lockX ?? clamped.scrollX;
      const scrollY = clamped.scrollY;

      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      const instantY =
        ((event.clientY - drag.lastClientY) / zoom / dt) * SCROLL_TOUCH_GAIN;
      panVelocityRef.current = {
        x: 0,
        y: panVelocityRef.current.y * 0.55 + instantY * 0.45,
      };
      drag.lastClientY = event.clientY;
      drag.lastT = now;
      lastPanScrollRef.current = { x: scrollX, y: scrollY, t: now };

      scheduleVisualScrollRef.current(scrollX, scrollY);
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = panDragRef.current;
      if (drag?.codeDockEl) {
        drag.codeDockEl.classList.remove("lc-code-dock-scrolling");
      }
      if (drag && drag.pointerId === event.pointerId) {
        try {
          root.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (!handPanningRef.current) return;
      handPanningRef.current = false;
      panDragRef.current = null;

      // Apply the last scheduled sample before velocity / settle so the coast
      // starts from where the finger actually was, not one rAF behind.
      flushVisualScrollRef.current();

      if (!canOwnScroll()) {
        rasterInkRef.current?.setCameraMoving(false);
        commitVisualScrollRef.current();
        return;
      }

      // The codeblock had the gesture; the page never moved and has nothing to
      // settle. Keep the lift away from Excalidraw all the same.
      if (drag?.sideScrollActive) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Code dock tap — never armed, let Monaco receive focus.
      if (drag?.codeDock && !drag.armed) {
        if (!inertiaFrameRef.current) {
          rasterInkRef.current?.setCameraMoving(false);
          commitVisualScrollRef.current();
        }
        return;
      }

      if (!drag?.armed) {
        if (!inertiaFrameRef.current) {
          rasterInkRef.current?.setCameraMoving(false);
          commitVisualScrollRef.current();
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const rawY = panVelocityRef.current.y;
      const velY = (() => {
        const cam = readScroll();
        const probe = clampPanScroll(cam.scrollX, cam.scrollY + rawY * 16, cam.zoom);
        return Math.abs(probe.scrollY - cam.scrollY) < 0.5 ? 0 : rawY;
      })();
      if (PAN_INERTIA_ENABLED && Math.abs(velY) >= PAN_FLICK_MIN) {
        startPanInertia(0, velY);
        return;
      }
      rasterInkRef.current?.setCameraMoving(false);
      commitVisualScrollRef.current();
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", onPointerUp, true);
    root.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      onSelectionGestureClaimed(null);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerup", onPointerUp, true);
      root.removeEventListener("pointercancel", onPointerUp, true);
      stopPanInertia();
    };
  }, [clampPanScroll, interactive, stopPanInertia]);

  /*
   * Two of Excalidraw's own gestures do not belong on a tablet board.
   *
   * **The context menu.** A long press on the canvas opens Excalidraw's menu —
   * canvas background, grid, zoom, the lot. On a desktop that is a right-click
   * and nobody finds it by accident; with a shape tool active on a tablet it is
   * indistinguishable from lining up where the shape goes, and the report that
   * prompted this describes exactly that: the settings sheet appeared, the
   * canvas took the next drag, and the writing went off screen. None of what
   * the menu offers is reachable only from there — the toolbar and the
   * selection trash cover it — so the whole gesture goes.
   *
   * **Double-click-to-create-text.** Excalidraw turns a double click on empty
   * canvas into a new text element and focuses its editor, which raises the
   * soft keyboard. With the pen that reads as "I tapped twice and a keyboard
   * appeared", and it fires under the select and shape tools where no text was
   * ever wanted. Blocked unless the text tool is genuinely up.
   *
   * `isTrusted` is the seam for the text tool's own flow: placing a note
   * dispatches a synthetic `dblclick` at the caret (see the placement effect
   * below) to hand off to Excalidraw's editor. A dispatched event is untrusted
   * by definition, so ours goes through this guard untouched while a real
   * double tap does not.
   */
  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    const onContextMenu = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (!event.isTrusted) return;
      if (activeToolRef.current === "text") return;
      event.preventDefault();
      event.stopPropagation();
    };

    /*
     * A tap on the page brings the controls back too.
     *
     * `hidden` used to have exactly one way out — the corner where the eye
     * would have been — and a control you cannot see is one you have to
     * remember. The corner keeps its dot, but a plain tap anywhere on the board
     * now does the same thing.
     *
     * Only with the scroll tool up, and only for a tap that did not travel: a
     * drag is a pan and a pen is writing, and neither is someone asking for the
     * toolbar. That restriction is also why this cannot fight the writer —
     * while a drawing tool is active this listener does nothing at all.
     */
    let tapAt: { x: number; y: number } | null = null;

    const onTapDown = (event: PointerEvent) => {
      tapAt =
        activeToolRef.current === "hand" ? { x: event.clientX, y: event.clientY } : null;
    };

    const onTapUp = (event: PointerEvent) => {
      const from = tapAt;
      tapAt = null;
      if (!from || activeToolRef.current !== "hand") return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > SELECT_HOLD_SLOP_PX) {
        return;
      }
      wakeChromeRef.current();
    };

    root.addEventListener("contextmenu", onContextMenu, true);
    root.addEventListener("dblclick", onDoubleClick, true);
    root.addEventListener("pointerdown", onTapDown);
    root.addEventListener("pointerup", onTapUp);
    return () => {
      root.removeEventListener("contextmenu", onContextMenu, true);
      root.removeEventListener("dblclick", onDoubleClick, true);
      root.removeEventListener("pointerdown", onTapDown);
      root.removeEventListener("pointerup", onTapUp);
    };
  }, [interactive]);

  /*
   * A shape must not be able to trap the pen, and must be deletable the moment
   * it exists.
   *
   * Two Excalidraw behaviours combine badly here. A *click* with the arrow tool
   * — as opposed to a drag — opens a multi-point line: every further tap adds a
   * bend, and the polyline is only closed by Escape, Enter or a double click.
   * On a keyboard-less tablet whose double click we have just taken away (see
   * the guard above), that is a state with no exit, which is what "I was stuck
   * in the arrow shape adding bends" describes. And because a multi-point line
   * in progress is not *selected*, the trash never appeared either, so the
   * arrow could not be removed once it was there.
   *
   * So: a drag draws a shape, a tap does nothing. Whatever the gesture leaves
   * behind is selected on release, which is what puts the trash over it.
   *
   * The work is deferred a frame because Excalidraw finishes its own pointerup
   * first — reading the scene synchronously here sees the state before the
   * element lands.
   */
  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;

    /** Shorter than this, in scene units, and the "arrow" was a stray tap. */
    const MIN_SHAPE_SPAN = 4;

    let idsAtDown: Set<string> | null = null;

    const shapeToolUp = () =>
      activeToolRef.current === "arrow" ||
      activeToolRef.current === "rectangle" ||
      activeToolRef.current === "ellipse";

    const onPointerDown = () => {
      const api = apiRef.current;
      if (!api || !shapeToolUp()) {
        idsAtDown = null;
        return;
      }
      idsAtDown = new Set(
        (api.getSceneElements() as Array<{ id: string; isDeleted?: boolean }>)
          .filter((el) => !el.isDeleted)
          .map((el) => el.id),
      );
    };

    const settle = () => {
      const api = apiRef.current;
      const before = idsAtDown;
      idsAtDown = null;
      if (!api || !before || !shapeToolUp()) return;

      const state = api.getAppState() as {
        multiElement?: { id?: string } | null;
        editingLinearElement?: { elementId?: string } | null;
      };
      const openId =
        state.multiElement?.id ?? state.editingLinearElement?.elementId ?? null;

      const live = api.getSceneElements() as Array<{
        id: string;
        type?: string;
        elbowed?: boolean;
        width?: number;
        height?: number;
        points?: readonly (readonly [number, number])[];
        isDeleted?: boolean;
        [key: string]: unknown;
      }>;

      const fresh = live.filter((el) => !el.isDeleted && !before.has(el.id));
      if (fresh.length === 0 && !openId) return;

      // A shape with no extent is a tap, not a drawing. Excalidraw keeps it as
      // the seed of a multi-point line; we throw it away instead.
      const spanOf = (el: (typeof live)[number]) => {
        const points = el.points;
        if (points && points.length > 0) {
          let span = 0;
          for (const [px, py] of points) span = Math.max(span, Math.hypot(px, py));
          return span;
        }
        return Math.hypot(el.width ?? 0, el.height ?? 0);
      };

      const strays = new Set(
        fresh.filter((el) => spanOf(el) < MIN_SHAPE_SPAN).map((el) => el.id),
      );
      const kept = fresh.filter((el) => !strays.has(el.id));

      const selected: Record<string, true> = {};
      for (const el of kept) selected[el.id] = true;

      const tool = activeToolRef.current;
      api.updateScene({
        elements: strays.size
          ? live.map((el) => (strays.has(el.id) ? { ...el, isDeleted: true } : el))
          : live,
        appState: {
          // Closing the polyline is the whole point — these two are what "stuck
          // in the arrow" actually was.
          multiElement: null,
          editingLinearElement: null,
          selectedElementIds: selected,
          selectedGroupIds: {},
          selectedLinearElement:
            kept.length === 1 && isLinearElementType(kept[0]?.type)
              ? linearEditorState({
                  id: kept[0]!.id,
                  elbowed: Boolean(kept[0]!.elbowed),
                })
              : null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      /*
       * Selecting the finished shape is what makes the trash appear, but
       * Excalidraw treats that selection as a reason to drop back to the
       * selection tool — undoing the `locked` we set when the tool was armed.
       * Re-assert the shape tool so a second rectangle is one gesture, not
       * three. The next drag clears the selection the way Excalidraw always
       * does when a locked shape tool starts a new mark.
       */
      if (tool === "arrow" || tool === "rectangle" || tool === "ellipse") {
        api.setActiveTool({ type: tool, locked: true });
      }
    };

    const onPointerUp = () => {
      if (!idsAtDown) return;
      requestAnimationFrame(settle);
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerUp);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
    };
  }, [interactive]);

  /*
   * Take the screen edges back from Android while writing.
   *
   * Back's left/right strips are claimed with exclusion rects (200dp budget,
   * centred on the hand). Home has no exclusion API — sticky immersive hides
   * the nav bar so the first swipe reveals chrome instead of leaving. Both
   * are armed only for pen / highlighter / eraser; reading and select keep
   * the system gestures. Strips and bars are restored on unmount.
   */
  useEffect(() => {
    const node = boardRef.current;
    const writing =
      interactive &&
      (activeTool === "freedraw" || activeTool === "highlighter" || activeTool === "eraser");
    if (!writing || !node) {
      void applyGestureExclusions([]);
      void setDrawingImmersive(false);
      return;
    }

    let focusY: number | null = null;
    let lastClaimY = Number.NaN;

    const claim = () => {
      const box = node.getBoundingClientRect();
      void applyGestureExclusions(
        edgeStrips(
          {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          },
          focusY,
        ),
      );
    };

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      focusY = event.clientY;
      if (!Number.isNaN(lastClaimY) && Math.abs(focusY - lastClaimY) < 40) return;
      lastClaimY = focusY;
      claim();
    };

    void setDrawingImmersive(true);
    claim();
    const observer = new ResizeObserver(claim);
    observer.observe(node);
    window.addEventListener("orientationchange", claim);
    node.addEventListener("pointerdown", onPointer);
    node.addEventListener("pointermove", onPointer);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", claim);
      node.removeEventListener("pointerdown", onPointer);
      node.removeEventListener("pointermove", onPointer);
      void applyGestureExclusions([]);
      void setDrawingImmersive(false);
    };
  }, [interactive, activeTool]);

  useEffect(() => {
    stopPanInertia();
    handPanningRef.current = false;
    panDragRef.current = null;
    rasterInkRef.current?.setCameraMoving(false);
    commitVisualScrollRef.current();
  }, [activeTool, stopPanInertia]);

  const inkToolActive =
    activeTool === "freedraw" ||
    activeTool === "eraser" ||
    activeTool === "highlighter";

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
      const boardRect = root.getBoundingClientRect();
      let rect = hitCanvas.getBoundingClientRect();
      if (hitCanvas.classList.contains("lc-raster-ink")) {
        const left = Math.max(rect.left, boardRect.left);
        const right = Math.min(rect.right, boardRect.right);
        const top = Math.max(rect.top, boardRect.top);
        const bottom = Math.min(rect.bottom, boardRect.bottom);
        if (left >= right || top >= bottom) {
          hide();
          return;
        }
        if (
          next.clientX < left ||
          next.clientX > right ||
          next.clientY < top ||
          next.clientY > bottom
        ) {
          hide();
          return;
        }
      } else if (
        next.clientX < rect.left ||
        next.clientX > rect.right ||
        next.clientY < rect.top ||
        next.clientY > rect.bottom
      ) {
        hide();
        return;
      }
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

  const commitStraightLine = useCallback(
    (stroke: {
      start: { x: number; y: number };
      end: { x: number; y: number };
      color: string;
      width: number;
      opacity: number;
    }) => {
      const api = apiRef.current;
      if (!api) return false;
      const dx = stroke.end.x - stroke.start.x;
      const dy = stroke.end.y - stroke.start.y;
      if (Math.hypot(dx, dy) < 4) return false;
      const pieces = convert([
        {
          type: "line",
          x: stroke.start.x,
          y: stroke.start.y,
          points: [
            [0, 0],
            [dx, dy],
          ],
          strokeColor: stroke.color,
          strokeWidth: Math.max(1, stroke.width),
          roughness: 0,
          opacity: Math.max(20, Math.min(100, Math.round(stroke.opacity * 100))),
          roundness: null,
        },
      ]) as Array<{ id: string; elbowed?: boolean }>;
      const line = pieces[0];
      if (!line?.id) return false;
      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), line],
        appState: {
          selectedElementIds: { [line.id]: true },
          selectedGroupIds: {},
          multiElement: null,
          editingLinearElement: null,
          selectedLinearElement: linearEditorState(line),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return true;
    },
    [convert],
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
    const ink = resolveInkColor(
      themeId,
      inkPrefsRef.current.inkColor,
      currentInkPalette(inkPaletteHistoryRef.current),
    );
    setInkColor(ink);
    if (!api) return;

    const dark = isDarkTheme(themeId);
    const elements = api.getSceneElements() as SceneElementLike[];
    const recolored = recolorTemplateElements(elements, dark);

    api.updateScene({
      appState: {
        viewBackgroundColor: boardViewBackground(
          transparentCanvasRef.current,
          theme.background,
        ),
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
    },
    [getZoomFloor, mobile],
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
      // Reading mode mutes .excalidraw hits — wheel still lands on .lc-board.
      if (!target.closest(".lc-board")) return;

      /*
       * Sideways over a wide codeblock is the block's, not the page's.
       *
       * A trackpad and a shifted wheel are the two ways to ask for it. The
       * first the browser can serve itself once we stop calling
       * `preventDefault` on it; the second it only sometimes maps to `deltaX`,
       * so do it by hand when it has not.
       */
      const sideScroll = horizontalScrollHost(target);
      if (sideScroll) {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        if (event.shiftKey && event.deltaY !== 0) {
          event.preventDefault();
          event.stopPropagation();
          sideScroll.scrollLeft += event.deltaY;
          return;
        }
      }

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
        // Prefer pending (scheduled) then live — wheel samples coalesce, so
        // chaining off only `live` would drop travel still waiting on rAF.
        const pending = pendingVisualScrollRef.current;
        const live = liveCameraRef.current;
        const baseY = pending
          ? pending.scrollY
          : live?.live
            ? live.scrollY
            : (state.scrollY ?? 0);
        const baseX = pending
          ? pending.scrollX
          : live?.live
            ? live.scrollX
            : (state.scrollX ?? 0);
        const wheeled = clampPanScroll(
          baseX,
          baseY - (event.deltaY / zoom) * SCROLL_WHEEL_GAIN,
          zoom,
        );
        if (scrollModeRef.current) lockedScrollXRef.current = wheeled.scrollX;
        scheduleVisualScrollRef.current(wheeled.scrollX, wheeled.scrollY);
        return;
      }

    };

    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [clampPanScroll, interactive, mobile, pulseCameraMotion, reportCodeSlot]);

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
          /*
           * A reading column is re-measured against the screen on every fit.
           *
           * Its scene width is what the width-only fit divides by, so it is
           * also what decides the type size — leaving it at whatever the frame
           * happened to be is how the statement ended up four screens wide with
           * 3px text. Re-deriving it here means a board saved under the old
           * geometry heals the first time it is opened, and a rotate or a coach
           * panel opening re-flows the column instead of shrinking the words.
           */
          const readingColumn = isReadingColumnFrame(primary);
          const frameW = Math.max(
            1,
            isScratch
              ? SCRATCH_PAGE_W
              : readingColumn
                ? readingColumnWidth(availWidth)
                : num(primary.width, REGIONS.approach.w),
          );
          // Raw ratio — do not floor to ZOOM_MIN or fillHeight collapses.
          const zoomForWidth = Math.max(0.05, Math.min(ZOOM_MAX, availWidth / frameW));
          const fillHeight = availHeight / zoomForWidth;
          const regionMin =
            typeof regionKey === "string" && regionKey in REGION_MIN
              ? REGION_MIN[regionKey as RegionId].minH
              : 800;
          const ops = rasterInkRef.current?.getOps() ?? [];
          let nextH: number;
          if (isDrawPageRegion(typeof regionKey === "string" ? regionKey : null)) {
            const basePageH = fillHeight;
            drawBasePageHRef.current = basePageH;
            const contentBottomRel = contentBottomInFrame(live, ops, {
              x: primary.x,
              y: primary.y,
              width: num(primary.width, 0),
              height: num(primary.height, 0),
              customData: primary.customData ?? undefined,
            });
            nextH = Math.max(
              regionMin,
              growDrawHeight({
                basePageH,
                currentH: num(primary.height, 0),
                contentBottomRel,
              }),
            );
          } else if (
            Boolean(
              (primary as { customData?: { lcDocumentPage?: boolean } }).customData
                ?.lcDocumentPage,
            )
          ) {
            // Statement / md-ink: keep at least the measured document height so
            // settleFitView cannot shrink the page back to one viewport and kill
            // vertical scroll (contentH <= visH → clamp locks Y).
            const docH = pageContentHeightRef.current;
            nextH = Math.max(
              regionMin,
              Math.round(fillHeight),
              docH != null && docH > 0 ? Math.round(docH) : 0,
            );
          } else {
            nextH = Math.max(regionMin, Math.round(fillHeight));
          }
          const curH = num(primary.height, 0);
          const widthChanged = Math.abs(num(primary.width, 0) - frameW) > 1;
          if (Math.abs(curH - nextH) > 1 || widthChanged) {
            const nextElements = live.map((element) =>
              element.id === primary.id ? { ...element, height: nextH, width: frameW } : element,
            ) as LayoutElement[];
            const synced = isScratch
              ? nextElements
              : syncRegionLayout(nextElements, {
                  codeContentHeight: codeContentHeightRef.current ?? undefined,
                  readingColumnWidth: readingColumn ? frameW : undefined,
                }) ?? nextElements;
            /*
             * A column that changed width is a page that has to be re-set.
             *
             * `syncRegionLayout` re-wraps the text to the new measure but the
             * type size comes from the reading pass, and that reads the column
             * width — so without this the statement keeps the font it was sized
             * for on the old screen.
             */
            if (readingColumn && widthChanged) {
              const reflow = reflowReadingTextRef.current;
              if (reflow) requestAnimationFrame(() => reflow());
            }
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
        /*
         * Width-only for draw pages too — fills the screen hole and zooms in
         * when height used to cap the camera (letterboxed gutters). Frame width
         * stays at the authored student column (not readingColumnWidth): shrinking
         * it made fillHeight ≈ viewport and killed vertical scroll.
         */
        const widthOnly =
          focus.some(
            (element) =>
              (element as { customData?: { lcDocumentPage?: boolean } }).customData
                ?.lcDocumentPage === true,
          ) ||
          page === "code" ||
          page === "agent" ||
          isDrawPageRegion(page);
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
        const nextScrollX = (inset.left + slackX / 2) / zoom - minX;
        const nextScrollY = (inset.top + slackY / 2) / zoom - minY;
        if (scrollModeRef.current) lockedScrollXRef.current = nextScrollX;
        api.updateScene({
          appState: {
            zoom: { value: zoom },
            scrollX: nextScrollX,
            scrollY: nextScrollY,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(() => {
          fittingCameraRef.current = false;
        });
        requestAnimationFrame(reportCodeSlot);
        requestAnimationFrame(reportLinedSlot);
        requestAnimationFrame(reportTitleSlot);
        requestAnimationFrame(reportContentSlot);
      }
      // Frame-only resize used to skip this: pageBoundsRef / inkClip stayed
      // on the first-open box, so the page still scrolled but ink died past
      // that initial view.
      syncPageVisibility();
    },
    [mobile, reportCodeSlot, reportContentSlot, reportLinedSlot, reportTitleSlot, syncPageVisibility],
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
  }, [linedPaperOn, linedPaperMode, reportLinedSlot]);

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
   *
   * Reset reseeds from `seedSkeletonsRef` (open-time height) and must call this
   * too — the effect below does not re-run when those props are unchanged, and
   * a short frame plus a kept `scrollY` clips new ink off-screen.
   */
  const applyDocumentFrameHeight = useCallback(
    (heightArg?: number | null) => {
      const api = apiRef.current;
      const height =
        heightArg != null && heightArg >= 1 ? heightArg : pageContentHeightRef.current;
      if (!api || !height || height < 1) return;
      const current = api.getSceneElements() as SceneElementLike[];
      const page = mobileRegionRef.current;
      const frame = current.find((el) => {
        const meta = (el as { customData?: { lcMdInkFrame?: boolean; lcRegion?: string; lcRegionFrame?: boolean } })
          .customData;
        return (
          meta?.lcMdInkFrame ||
          (Boolean(pageContentRef.current) &&
            meta?.lcRegionFrame &&
            meta.lcRegion === "constraints" &&
            (page === "constraints" || page === null))
        );
      }) as (SceneElementLike & { height?: number }) | undefined;
      if (!frame) return;
      if (typeof frame.height === "number" && Math.abs(frame.height - height) < 1) {
        syncPageVisibility();
        scheduleSlotReports();
        return;
      }
      const isMdFrame = Boolean(
        (frame as { customData?: { lcMdInkFrame?: boolean } }).customData?.lcMdInkFrame,
      );
      const grown = current.map((el) =>
        el === frame
          ? ({
              ...el,
              height,
              ...(isMdFrame ? { locked: true } : {}),
              versionNonce: Math.random() * 2 ** 31,
            } as LayoutElement)
          : el,
      ) as LayoutElement[];
      api.updateScene({
        elements: grown as unknown[],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      syncPageVisibility();
      scheduleSlotReports();
    },
    [scheduleSlotReports, syncPageVisibility],
  );

  useEffect(() => {
    applyDocumentFrameHeight(pageContentHeight);
  }, [pageContent, pageContentHeight, applyDocumentFrameHeight]);

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

  // Entering or leaving Carbon / transparent paper flips the canvas after the
  // theme has already been applied, so it needs its own push.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const themeBg =
      (BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0])
        .background;
    api.updateScene({
      appState: {
        viewBackgroundColor: boardViewBackground(transparentCanvas, themeBg),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [transparentCanvas, docPaper, themeId]);

  useEffect(() => {
    reportTitleSlot();
  }, [mobileRegion, interactive, reportTitleSlot]);

  /**
   * A new board — or a page turn — starts the wayfinding over.
   *
   * Free-scroll: reset so the first camera move names the page. Paged: the
   * pager already knows the region, so show the fade pill on a real turn
   * (skip the first mount so opening a problem does not flash the title).
   */
  useEffect(() => {
    lastPageCameraRef.current = null;
    if (!interactive) {
      pageIndicatorRef.current?.hide();
      return;
    }
    if (mobileRegion === null) {
      lastNamedPageRef.current = null;
      return;
    }
    const prev = lastNamedPageRef.current;
    const index = MOBILE_REGION_ORDER.indexOf(mobileRegion as RegionId);
    if (index < 0) {
      lastNamedPageRef.current = null;
      return;
    }
    const region = MOBILE_REGION_ORDER[index];
    if (prev === region) return;
    lastNamedPageRef.current = region;
    if (prev === null) return;
    pageIndicatorRef.current?.show(
      REGIONS[region].label,
      index,
      MOBILE_REGION_ORDER.length,
      REGION_BLURB[region],
    );
  }, [mobileRegion, interactive]);

  /** Page-locked boards: grow the frame and refit width on every board resize. */
  useEffect(() => {
    if (!interactive) return;
    const board = boardRef.current;
    if (!board || typeof ResizeObserver === "undefined") return;
    let timer: number | null = null;
    const run = () => {
      // Once the user has zoomed or panned, the camera is theirs: resize the
      // page frame to the new viewport, but leave zoom and scroll alone.
      // Desktop used to bail when `mobileRegion === null`, so opening a file
      // and then resizing the window never refit the reading column.
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
      reportContentSlot();
    })();
  }, [refitToViewport, reportContentSlot]);

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
    },
    [convert],
  );

  /** Place an image element at viewport center (or an explicit scene rect). */
  const insertImageFromDataURL = useCallback(
    async (
      rawDataURL: string,
      mimeType: string,
      place?: { x: number; y: number; width: number; height: number },
    ) => {
      const api = apiRef.current;
      if (!api) return;
      // Every insert path — file picker, paste, board capture, region crop —
      // arrives here, so this is the one place the cap has to be applied. It
      // was applied nowhere: a 4 MB phone photo went into the saved blob at
      // full size as a base64 dataURL stored in UTF-16, which is more than the
      // whole origin's budget for one image.
      const dataURL = await shrinkImageDataURL(rawDataURL);
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
      setCaptureMenuOpen(false);
      setCaptureArmed(false);
      setCaptureRegion(null);
    },
    [],
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
  const reportCapture = useCallback(async (blob: Blob, mode: CaptureMode) => {
    const feedback = captureFeedbackRef.current;
    if (!captureWritesFile(mode)) {
      feedback?.toast("Added to the board");
      return;
    }
    // The write is the slow half — asking for permission, copying into a
    // gallery — and until it says so the reader cannot tell a save in progress
    // from a save that silently did nothing.
    feedback?.saving();
    try {
      const result = await saveCaptureToDevice(blob);
      feedback?.toast(
        describeCaptureResult(result),
        result.outcome === "failed" ? "error" : "ok",
      );
    } catch (cause) {
      feedback?.toast(`Could not save — ${String(cause)}`, "error");
    }
  }, []);

  const pageExportLayers = useCallback((): PageExportLayers | null => {
    if (!pageContentRef.current) return null;
    const theme =
      BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
    const cssBg =
      typeof document !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
        : "";
    const exportPage =
      mobileRegionRef.current ?? focusRegionRef.current ?? "constraints";
    // Always remasure for the export target page. Desktop free-scroll keeps
    // pageBoundsRef on constraints while the pager focus may be elsewhere;
    // a stale null/wrong box was the ink-only Annotation path.
    let bounds: SceneBounds | null = null;
    const api = apiRef.current;
    if (api) {
      const live = api.getSceneElements() as unknown as PageableElement[];
      const raw = pageBounds(live, exportPage);
      if (raw) {
        const pad = REGION_GUTTER / 2;
        bounds = {
          minX: raw.minX + pad,
          minY: raw.minY + pad,
          maxX: raw.maxX - pad,
          maxY: raw.maxY - pad,
        };
        pageBoundsRef.current = bounds;
      }
    }
    if (!bounds) bounds = pageBoundsRef.current;
    const contentSlot = contentSlotNodeRef.current;
    const marksSlot = marksSlotNodeRef.current;
    if (!contentSlot && !marksSlot) return null;
    return {
      contentSlot,
      marksSlot,
      pageBounds: bounds,
      paperColor: cssBg || theme.background || "#ffffff",
    };
  }, [themeId]);

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
    const mode = loadCaptureMode();
    const blob = await exportBoardBlob(
      api,
      rasterInkRef.current?.getOps() ?? [],
      deviceExportScale(),
      pageExportLayers(),
    );
    if (!blob || blob.size === 0) {
      feedback?.toast("Nothing to capture", "error");
      return;
    }
    // "Save only" leaves the page alone: a shot taken to keep is not always a
    // picture you want pasted into the middle of what you were writing.
    if (captureInserts(mode)) {
      const dataURL = await blobToDataURL(blob);
      await insertImageFromDataURL(dataURL, "image/png");
    }
    await reportCapture(blob, mode);
  }, [insertImageFromDataURL, pageExportLayers, reportCapture]);

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
      const mode = loadCaptureMode();
      const blob = await exportSceneFrameBlob(
        api,
        rasterInkRef.current?.getOps() ?? [],
        { x, y, width, height },
        deviceExportScale(),
        pageExportLayers(),
      );
      if (!blob || blob.size === 0) {
        feedback?.toast("Nothing to capture", "error");
        return;
      }
      if (captureInserts(mode)) {
        const dataURL = await blobToDataURL(blob);
        await insertImageFromDataURL(dataURL, "image/png", { x, y, width, height });
      }
      await reportCapture(blob, mode);
    },
    [clientToScene, insertImageFromDataURL, pageExportLayers, reportCapture],
  );



  // Excalidraw can reset the active tool during its own mount; re-assert hand
  // once the API is live so a session starts scrolling, not selecting.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!annotateCodeRef.current) ensureReadingHand();
    }, 120);
    return () => clearTimeout(timer);
  }, [activeTool, ensureReadingHand]);

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
    const sized = applyBoardReadingSize(recolored, readingSizeRef.current, readingOpts("M"));
    templateRef.current = sized;
    /*
     * Keep the camera. Clearing marks is not "jump back to the top of the
     * page" — the student was reading mid-document and Reset only promised
     * a clean board. `refitToViewport` / `scheduleFitView` used to wipe
     * scrollX/Y (and markdown slot) back to the start.
     */
    const api = apiRef.current;
    const prior = api?.getAppState() as
      | { scrollX?: number; scrollY?: number; zoom?: { value?: number } }
      | undefined;
    api?.updateScene({
      elements: sized as unknown[],
      appState: {
        scrollX: prior?.scrollX,
        scrollY: prior?.scrollY,
        zoom: prior?.zoom,
        selectedElementIds: {},
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    // Reseeding undoes frame growth. Re-apply measured paper height before
    // the clip/pan refresh — otherwise a kept scrollY maps the nib outside
    // the short seed frame and new ink is invisible until a toggle re-grows it.
    applyDocumentFrameHeight();
    maybeGrowDrawFrame();
    syncPageVisibility();
    const cam = api?.getAppState() as
      | { scrollX?: number; scrollY?: number; zoom?: { value?: number } }
      | undefined;
    if (api && cam) {
      const zoom = cam.zoom?.value ?? 1;
      const next = clampPanScroll(cam.scrollX ?? 0, cam.scrollY ?? 0, zoom);
      if (next.scrollX !== (cam.scrollX ?? 0) || next.scrollY !== (cam.scrollY ?? 0)) {
        api.updateScene({
          appState: { scrollX: next.scrollX, scrollY: next.scrollY, zoom: cam.zoom },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    }
    scheduleSlotReports();
  }, [
    applyDocumentFrameHeight,
    clampPanScroll,
    convert,
    maybeGrowDrawFrame,
    scheduleSlotReports,
    syncPageVisibility,
    themeId,
  ]);

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

  // Code page frame height — same contract as before, not mixed with HTML paper.
  useEffect(() => {
    if (codeContentHeight == null || codeContentHeight < 1) return;
    if (
      codeContentHeightRef.current !== null &&
      Math.abs(codeContentHeightRef.current - codeContentHeight) < 1
    ) {
      return;
    }
    codeContentHeightRef.current = codeContentHeight;
    applyRegionLayout();
    requestAnimationFrame(reportCodeSlot);
  }, [applyRegionLayout, codeContentHeight, reportCodeSlot]);

  // Keep the fit path honest about measured paper height (statement / md-ink).
  useEffect(() => {
    pageContentHeightRef.current =
      pageContentHeight != null && pageContentHeight >= 1 ? pageContentHeight : null;
  }, [pageContentHeight]);

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
      const scaled = applyBoardReadingSize(
        current,
        size,
        readingOpts(opts?.captureFrom ?? size),
      );
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
  reflowReadingTextRef.current = reflowReadingText;

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
    /*
     * A saved PDF camera is applied before interactive flips true. The open
     * fit here used to wipe that and land on page 1 every time.
     */
    const keepCamera = becameInteractive && userAdjustedCameraRef.current;
    if (!keepCamera) userAdjustedCameraRef.current = false;
    // Hide the other pages *before* fitting: a page is the only thing on the
    // canvas, so zooming out on a tablet shows one frame, not the whole column.
    // Ink clip tracks the same box — without this, marks from the previous page
    // can flash on the next one until the next camera tick.
    syncPageVisibility();
    reportCodeSlot();
    rasterInkRef.current?.syncCamera();
    if (keepCamera) {
      if (!annotateCodeRef.current) armReadingScroll();
      return;
    }
    void settleFitView().then(() => {
      reportCodeSlot();
      rasterInkRef.current?.syncCamera();
      // Fit runs after view-mode exit and can wipe the hand tool. Re-arm so
      // md-ink / reading scroll sticks without an annotate toggle (15912fe).
      if (!annotateCodeRef.current) armReadingScroll();
    });
  }, [
    interactive,
    mobileRegion,
    armReadingScroll,
    reportCodeSlot,
    settleFitView,
    syncPageVisibility,
  ]);

  /*
   * Leaving view mode (interactive false → true) resets Excalidraw.
   * Arm reading scroll only after that flip — same moment the toolbar toggle
   * works. Retry past settleFitView: Excalidraw finishes view-mode exit
   * asynchronously, and a fit that lands later must not leave selection armed.
   */
  useEffect(() => {
    if (!interactive || annotateCodeRef.current) return;
    const arm = () => {
      if (!annotateCodeRef.current) armReadingScroll();
    };
    arm();
    const raf = requestAnimationFrame(arm);
    const timers = [50, 200, 500, 1000].map((ms) => window.setTimeout(arm, ms));
    return () => {
      cancelAnimationFrame(raf);
      for (const id of timers) window.clearTimeout(id);
    };
  }, [interactive, armReadingScroll]);

  /**
   * Place the selection trash from live geometry, not from the last committed
   * scene snapshot.
   *
   * `handleSceneChange` skips most work when Excalidraw reuses the elements
   * array or leaves `version` alone — which is what a move and a linear-point
   * drag do until pointer-up. The trash used to live behind that skip, so it
   * sat still until the gesture committed. This path reads `getSceneElements`
   * plus in-flight clones (`draggingElement` / `resizingElement`) and writes
   * left/top to the button node so a follow frame does not re-render Board.
   */
  const syncStampTrash = useCallback(() => {
    const api = apiRef.current;
    if (!api) {
      stampTrashPosRef.current = null;
      setStampTrash((current) => (current ? null : current));
      return;
    }
    const state = api.getAppState() as {
      selectedElementIds?: Record<string, boolean>;
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
      draggingElement?: TrashEl | null;
      resizingElement?: TrashEl | null;
      newElement?: TrashEl | null;
    };
    const selectedIds = new Set(
      Object.entries(state.selectedElementIds ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id),
    );
    const hide = () => {
      stampTrashPosRef.current = null;
      setStampTrash((current) => (current ? null : current));
    };
    if (selectedIds.size === 0) {
      hide();
      return;
    }
    const els = withLiveTrashEls(api.getSceneElements() as TrashEl[], [
      state.draggingElement,
      state.resizingElement,
      state.newElement,
    ]);
    const selected = els.filter(
      (el) => selectedIds.has(el.id) && !el.isDeleted && isDeletableElement(el),
    );
    if (selected.length === 0) {
      hide();
      return;
    }
    const groupIds = new Set(
      selected
        .map((el) => el.customData?.lcStampGroup)
        .filter((id): id is string => Boolean(id)),
    );
    const toDelete = els.filter((el) => {
      if (el.isDeleted || !isDeletableElement(el)) return false;
      if (selectedIds.has(el.id)) return true;
      const g = el.customData?.lcStampGroup;
      return Boolean(g && groupIds.has(g) && el.customData?.lcStamp);
    });
    const live = liveCameraRef.current;
    const camera = live?.live
      ? { scrollX: live.scrollX, scrollY: live.scrollY, zoom: live.zoom }
      : {
          scrollX: state.scrollX ?? 0,
          scrollY: state.scrollY ?? 0,
          zoom: state.zoom?.value ?? 1,
        };
    const board = boardRef.current;
    const bounds = selectionBounds(toDelete);
    const anchor = bounds
      ? trashAnchor(bounds, camera, {
          width: board?.clientWidth ?? window.innerWidth,
          height: board?.clientHeight ?? window.innerHeight,
        })
      : null;
    if (!anchor) {
      hide();
      return;
    }
    stampTrashPosRef.current = anchor;
    const node = stampTrashNodeRef.current;
    if (node) {
      node.style.left = `${anchor.left}px`;
      node.style.top = `${anchor.top}px`;
    }
    const ids = toDelete.map((el) => el.id);
    setStampTrash((current) => {
      if (
        current &&
        current.ids.length === ids.length &&
        current.ids.every((id, i) => id === ids[i])
      ) {
        return current;
      }
      return { ids };
    });
  }, []);
  syncStampTrashRef.current = syncStampTrash;

  useEffect(() => {
    if (!interactive) return;
    const root = boardRef.current;
    if (!root) return;
    let tracking = false;
    let raf = 0;
    const tick = () => {
      raf = 0;
      syncStampTrashRef.current();
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(tick);
    };
    const onDown = () => {
      tracking = true;
    };
    const onMove = () => {
      if (!tracking) return;
      schedule();
    };
    const onUp = () => {
      if (!tracking) return;
      tracking = false;
      schedule();
    };
    root.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      root.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [interactive]);

  const handleSceneChange = useCallback(
    (
      _elements?: readonly unknown[],
      appState?: {
        editingTextElement?: { id?: string } | null;
        isResizing?: boolean;
        resizingElement?: { id?: string; type?: string } | null;
        newElement?: { type?: string } | null;
        selectedElementIds?: Record<string, boolean>;
        selectedLinearElement?: { elementId?: string } | null;
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
        layoutSyncingRef.current ||
        liveCameraRef.current?.live
      ) {
        syncStampTrash();
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

      if (selectedIds.length === 1) {
        const hit = (
          api.getSceneElements() as Array<{
            id: string;
            type?: string;
            elbowed?: boolean;
            isDeleted?: boolean;
          }>
        ).find((candidate) => candidate.id === selectedIds[0] && !candidate.isDeleted);
        if (
          hit &&
          isLinearElementType(hit.type) &&
          appState?.selectedLinearElement?.elementId !== hit.id
        ) {
          api.updateScene({
            appState: { selectedLinearElement: linearEditorState(hit) },
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
        syncStampTrash();
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
        syncStampTrash();
        return;
      }
      lastSceneElementsRevRef.current = elementsRev;
      lastSelectionSigRef.current = selectionSig;

      // Frames: pin column position, zero rotation; resize height/width still works.
      applyRegionLayout();
      maybeGrowDrawFrame();
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
      syncStampTrash();

      onChange?.();
    },
    [
      activeTool,
      applyRegionLayout,
      maybeGrowDrawFrame,
      onChange,
      reportCodeSlot,
      setTool,
      syncPageVisibility,
      syncStampTrash,
    ],
  );

  const handleInkChange = useCallback(() => {
    onChange?.();
    if (maybeGrowDrawFrame()) {
      scheduleSlotReports();
    }
  }, [maybeGrowDrawFrame, onChange, scheduleSlotReports]);

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
        const next = applyBoardReadingSize(recolored, readingSizeRef.current, readingOpts("M"));
        templateRef.current = next;
        rasterInkRef.current?.clear();
        applyInkPaletteHistoryRef.current(seedInkPaletteHistory(themeId));
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
          ensureReadingHand();
        });
      },
      resetTemplate,
      exportPng: async () => {
        const api = apiRef.current;
        if (!api) return "";
        // Downscaled inside captureImage — a full-size export of this board is
        // tens of megabytes, which is what the daemon refused to buffer.
        return captureImage(() =>
          exportBoardBlob(api, rasterInkRef.current?.getOps() ?? [], 1, pageExportLayers()),
        );
      },
      exportRegionThumbs: async () => {
        const api = apiRef.current;
        if (!api) return [];
        const all = api.getSceneElements() as SceneElementLike[];
        const ops = rasterInkRef.current?.getOps() ?? [];
        const thumbs: Array<{ region: RegionId; label: string; png: string }> = [];
        /*
         * A screenful of page, in scene units.
         *
         * The pages scroll now, so "one region" can be five screens of work,
         * and one crop that tall arrives at the model as an unreadable strip.
         * The width-only fit means a screen is `frameWidth × viewH / viewW` of
         * scene, which is the bound the splitter cuts against.
         */
        const view = api.getAppState() as { width?: number; height?: number };
        const viewW = num(view.width, 0);
        const viewH = num(view.height, 0);
        const screenfulOf = (frameWidth: number) =>
          viewW > 0 && viewH > 0 ? Math.max(240, (frameWidth * viewH) / viewW) : 0;

        for (const region of STUDENT_REGION_ORDER) {
          /*
           * Code is excluded because it is not a picture: Monaco is HTML, so a
           * canvas crop of the code page comes back as marks over an empty
           * rectangle. That page is sent as re-rendered source with the ink
           * composited on top (see `renderAnnotatedCode`). Everything else,
           * the statement included, is captured here — annotations on the
           * problem statement used to be sent nowhere at all.
           */
          if (region === "code") continue;
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

          /*
           * Only send a page that has something *of the student's* on it.
           *
           * The statement page is full of template text — the whole problem is
           * printed on it — so counting authored elements would attach it to
           * every turn. What makes a page worth sending is a mark that was not
           * there when the page was seeded.
           */
          const authored = inBox.filter(
            (el) =>
              !el.customData?.lcRegionFrame &&
              !el.customData?.lcRegion &&
              !el.id.startsWith("lcregion-"),
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

          const frameRect = {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            // The splitter only reads `lcRegion`; the frame's meta is wider.
            customData: frame.customData ?? undefined,
          };
          const contentBoxes = contentAABBsInFrame(all, ops, frameRect);
          const splitRects = inkRegionSplit(
            frameRect,
            contentBoxes,
            INK_REGION_GAP,
            INK_REGION_PAD,
            screenfulOf(frame.width),
          );
          const crops =
            splitRects.length > 0
              ? splitRects
              : [{ x: frame.x, y: frame.y, width: frame.width, height: frame.height }];

          for (let index = 0; index < crops.length; index++) {
            const crop = crops[index];
            const cropElements = inBox.filter((el) => {
              const cx = el.x + el.width / 2;
              const cy = el.y + el.height / 2;
              return (
                cx >= crop.x &&
                cy >= crop.y &&
                cx <= crop.x + crop.width &&
                cy <= crop.y + crop.height
              );
            });
            const png = await captureImage(
              () =>
                exportRegionBlob(
                  api,
                  ops,
                  cropElements as SceneElementLike[],
                  {
                    x: crop.x,
                    y: crop.y,
                    width: crop.width,
                    height: crop.height,
                  },
                  1,
                  pageExportLayers(),
                ),
              { maxEdge: 640, maxBase64: 2 * 1024 * 1024 },
            );
            if (png) {
              const baseLabel = REGIONS[region].label;
              thumbs.push({
                region,
                label: crops.length > 1 ? `${baseLabel} ${index + 1}` : baseLabel,
                png,
              });
            }
          }
        }

        /*
         * A page with no regions is still a board.
         *
         * The loop above walks `STUDENT_REGION_ORDER` and needs an
         * `lcRegionFrame` to crop against. A scratchpad and a document pad have
         * none — they are one continuous surface — so "Whole board" came back
         * empty and Annotate attached nothing at all. Falling back to what is
         * actually drawn keeps the phrase honest on every kind of page.
         *
         * Region crops stay preferred where they exist: a full-board thumb is
         * huge in chat and duplicates whatever was already sent as Approach.
         */
        if (thumbs.length === 0) {
          const drawn = all.filter(
            (el) => !el.isDeleted && !el.customData?.lcRegionFrame && !el.customData?.lcVizId,
          );
          if (drawn.length > 0 || ops.length > 0) {
            const png = await captureImage(
              () => exportBoardBlob(api, ops, 1, pageExportLayers()),
              {
              maxEdge: 640,
              maxBase64: 2 * 1024 * 1024,
            },
            );
            if (png) thumbs.push({ region: STUDENT_REGION_ORDER[0], label: "Board", png });
          }
        }
        return thumbs;
      },
      exportViewThumb: async () => {
        const api = apiRef.current;
        if (!api) return null;
        const state = api.getAppState() as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
          width?: number;
          height?: number;
        };
        const zoom = num(state.zoom?.value, 1) || 1;
        const viewW = num(state.width, 0);
        const viewH = num(state.height, 0);
        if (viewW <= 0 || viewH <= 0) return null;
        // Excalidraw's camera: sceneX = viewportX / zoom - scrollX.
        const crop = {
          x: -num(state.scrollX, 0),
          y: -num(state.scrollY, 0),
          width: viewW / zoom,
          height: viewH / zoom,
        };

        const all = api.getSceneElements() as SceneElementLike[];
        const ops = rasterInkRef.current?.getOps() ?? [];
        /*
         * Anything *overlapping* the crop, not only what is centred in it.
         *
         * A region crop is a window onto a page, so a paragraph or a stroke that
         * runs off the top of the screen is still part of what the reader is
         * looking at — dropping it because its midpoint is above the fold would
         * cut the sentence the question is about.
         */
        const visible = all.filter((el) => {
          if (el.isDeleted) return false;
          if (el.customData?.lcVizId) return false;
          return (
            el.x <= crop.x + crop.width &&
            el.y <= crop.y + crop.height &&
            el.x + el.width >= crop.x &&
            el.y + el.height >= crop.y
          );
        });

        const png = await captureImage(
          () => exportRegionBlob(api, ops, visible, crop, 1, pageExportLayers()),
          { maxEdge: 640, maxBase64: 2 * 1024 * 1024 },
        );
        return png ? { label: "This view", png } : null;
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
      getInkOpCount: () => rasterInkRef.current?.getOpCount() ?? 0,
      isInking: () => rasterInkRef.current?.isDrawing() ?? false,
      dirtyInkPageCount: () => rasterInkRef.current?.dirtyInkPageCount() ?? 0,
      takeDirtyInkPages: () => rasterInkRef.current?.takeDirtyInkPages() ?? new Map(),
      markInkPagesFlushed: (pageIds) => {
        rasterInkRef.current?.markInkPagesFlushed(pageIds);
      },
      ingestInkPages: (pages) => {
        rasterInkRef.current?.ingestInkPages(pages);
        if (maybeGrowDrawFrame()) scheduleSlotReports();
        syncPageVisibility();
      },
      encodedInkShards: () => rasterInkRef.current?.encodedShards() ?? [],
      assembleEncodedInk: () =>
        rasterInkRef.current?.assembleEncoded() ?? encodeInkOps([]),
      announce: (label) => {
        modeIndicatorRef.current?.show(label, ANNOUNCE_HOLD_MS);
      },
      showPadTitle: (label) => {
        padTitleRef.current?.show(label);
      },
      setInkOps: (ops) => {
        rasterInkRef.current?.setOps(ops);
        /*
         * Restored ink has to grow the page, the same as drawn ink does.
         *
         * The frame starts at one screen and grows to whatever has been written
         * on it — but only ever from `handleInkChange`, which the pen fires and
         * a restore does not. So a notebook came back with its writing laid out
         * for a page several screens tall inside a frame one screen high, and
         * the camera fitted the frame. That is the gap the writer sees above
         * their notes on open, and why it fixes itself the moment they draw
         * anything: the first stroke is the first thing that ever asks the page
         * how big it should be.
         */
        if (maybeGrowDrawFrame()) scheduleSlotReports();
        syncPageVisibility();
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
      scrollToPdfPage: (pageId: number) => {
        const api = apiRef.current;
        const slot = contentSlotNodeRef.current;
        const bounds = pageBoundsRef.current;
        if (!api || !slot || !bounds || pageId < 1) return;
        const node = slot.querySelector<HTMLElement>(`[data-pdf-page="${pageId}"]`);
        if (!node) return;
        const slotRect = slot.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        const pageH = bounds.maxY - bounds.minY;
        if (slotRect.height < 1 || pageH <= 0) return;
        const sy = slotRect.height / pageH;
        const minY = bounds.minY + (box.top - slotRect.top) / sy;
        const state = api.getAppState() as { zoom?: { value?: number } };
        const zoom = state.zoom?.value ?? 1;
        if (!(zoom > 0)) return;
        const measured = measureChromeInsets(
          boardRef.current,
          toolbarHeightRef.current,
          mapChromeHiddenRef.current,
          mobileRef.current,
        );
        const insetTop = measured.top + (mobileRef.current ? 0 : safeCssPx("--lc-safe-top"));
        userAdjustedCameraRef.current = true;
        api.updateScene({
          appState: { scrollY: insetTop / zoom - minY },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        scheduleSlotReports();
      },
      restoreView: (saved) => {
        const api = apiRef.current;
        if (!api || !saved) return;
        userAdjustedCameraRef.current = true;
        const zoom = saved.zoom > 0 ? saved.zoom : 1;
        const frames = pageFramesFromPdfSlot(
          contentSlotNodeRef.current,
          pageBoundsRef.current,
        );
        if (frames.length >= 2) {
          const state = api.getAppState() as { height?: number };
          const page = pageIdFromCamera(frames, saved.scrollY, zoom, state.height ?? 800);
          const node = contentSlotNodeRef.current?.querySelector<HTMLElement>(
            `[data-pdf-page="${page}"]`,
          );
          if (node) {
            const slot = contentSlotNodeRef.current;
            const bounds = pageBoundsRef.current;
            if (slot && bounds) {
              const slotRect = slot.getBoundingClientRect();
              const box = node.getBoundingClientRect();
              const pageH = bounds.maxY - bounds.minY;
              if (slotRect.height >= 1 && pageH > 0) {
                const sy = slotRect.height / pageH;
                const minY = bounds.minY + (box.top - slotRect.top) / sy;
                const liveZoom =
                  (api.getAppState() as { zoom?: { value?: number } }).zoom?.value ?? zoom;
                const measured = measureChromeInsets(
                  boardRef.current,
                  toolbarHeightRef.current,
                  mapChromeHiddenRef.current,
                  mobileRef.current,
                );
                const insetTop =
                  measured.top + (mobileRef.current ? 0 : safeCssPx("--lc-safe-top"));
                api.updateScene({
                  appState: { scrollY: insetTop / liveZoom - minY },
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
                scheduleSlotReports();
                return;
              }
            }
          }
        }
        api.updateScene({
          appState: {
            scrollX: saved.scrollX,
            scrollY: saved.scrollY,
            zoom: { value: zoom },
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        scheduleSlotReports();
      },
      appendScratchPage: (skeletons: Skeleton[]) => {
        const api = apiRef.current;
        if (!api || skeletons.length === 0) return 0;
        const dark = isDarkTheme(themeId);
        const converted = convert(skeletons, { regenerateIds: false }) as SceneElementLike[];
        const recolored = recolorTemplateElements(converted, dark) ?? converted;
        const sized = applyBoardReadingSize(recolored, readingSizeRef.current, readingOpts("M"));
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
      saveBoard: (opts) => {
        const api = apiRef.current;
        const state = (api?.getAppState() ?? {}) as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value?: number };
        };
        const kept = elements().filter((element) => !isCoachElement(element));
        const assemble = opts?.assembleInk !== false;
        const inkC = assemble
          ? (rasterInkRef.current?.assembleEncoded() ?? encodeInkOps([]))
          : { v: 2 as const, ops: [] };
        const pageIds = rasterInkRef.current?.inkPageIds() ?? [];
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
          // Encoded, not raw — `ink` stays readable forever but is never
          // written again. See `inkCodec`; read it back with `inkOpsFrom`.
          inkC,
          ...(pageIds.length > 0 ? { inkPages: { v: 1 as const, pageIds } } : {}),
          inkPalettes: {
            items: inkPaletteHistoryRef.current.items,
            index: inkPaletteHistoryRef.current.index,
          },
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
        /*
         * Boards saved when regions had labels and hints carry those elements.
         * Nothing draws them any more, but they are still in the file — so a
         * restore that kept them would put "APPROACH / What are you scanning?"
         * back on a page that is supposed to be blank.
         */
        const chromeStripped = scratchHealed.filter((el) => {
          const id = typeof el.id === "string" ? el.id : "";
          if (
            id.startsWith("lcregion-") &&
            (id.endsWith("-label") || id.endsWith("-hint"))
          ) {
            return false;
          }
          /*
           * The scratchpad's baked "Scratchpad" heading, for the same reason.
           * Every notebook ever saved carries one at the top-left of its first
           * page; the name is announced over the board on open now instead of
           * living on it. See `buildScratchPageSkeletons`.
           */
          return !/^lcscratch-\d+-title$/.test(id);
        });
        const healed = healBoardLayout(chromeStripped, {
            readingSize: readingSizeRef.current,
            codeContentHeight: codeContentHeightRef.current ?? undefined,
            viewportWidth: boardCssWidth(),
          },
        );
        // Keep a fit target so landing zooms to problem+code, not the full board.
        templateRef.current = healed as unknown[];
        // Drop saved camera — never pass zoom: undefined (Excalidraw crashes).
        // Also drop tool/selection: a board saved while annotating would restore
        // Select, and finger-scroll dies until the toolbar is toggled.
        const saved = { ...((appState as Record<string, unknown> | undefined) ?? {}) };
        delete saved.zoom;
        delete saved.scrollX;
        delete saved.scrollY;
        delete saved.activeTool;
        delete saved.selectedElementIds;
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
        /*
         * Ink is absolute scene points, so it has to be carried across the heal.
         *
         * `healBoardLayout` re-stacks the saved frames onto today's rules, and a
         * board saved under different geometry lands with every page below the
         * first at a new Y. Elements ride that out on their `lcRegionOy`
         * offsets; pen strokes have no frame to hang off and would be left
         * behind on the desk between pages.
         */
        rasterInkRef.current?.setOps(
          reanchorInkOps(
            chromeStripped as unknown as LayoutElement[],
            healed as unknown as LayoutElement[],
            options?.ink ?? [],
          ),
        );
        applyInkPaletteHistoryRef.current(
          normalizeInkPaletteHistory(options?.inkPalettes, themeId),
        );
        ensureReadingHand();
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          syncPageVisibility();
          if (!options?.skipFit) scheduleFitView();
          ensureReadingHand();
        });
      },
      applyThemeInk: (nextThemeId: string) => {
        const api = apiRef.current;
        if (!api) return;
        const dark = isDarkTheme(nextThemeId);
        const theme = BOARD_THEMES.find((candidate) => candidate.id === nextThemeId) ?? BOARD_THEMES[0];
        const ink = resolveInkColor(
          nextThemeId,
          inkPrefsRef.current.inkColor,
          currentInkPalette(inkPaletteHistoryRef.current),
        );
        setInkColor(ink);
        const scene = api.getSceneElements() as SceneElementLike[];
        const recolored = recolorTemplateElements(scene, dark);
        api.updateScene({
          appState: {
            viewBackgroundColor: boardViewBackground(
              transparentCanvasRef.current,
              theme.background,
            ),
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
      armReadingScroll,
    }),
    [convert, elements, fitCamera, fitCodeToSource, fitCurrentView, fitFrame, fitView, maybeGrowDrawFrame, refitToViewport, scheduleSlotReports, settleFitView, waitForTemplate, resetTemplate, scheduleFitView, setTool, syncPageVisibility, themeId, undoBoard, zoomIn, zoomOut, ensureReadingHand, armReadingScroll],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  const initialData = useMemo(
    () => {
      const prefs = inkPrefsRef.current;
      return {
        appState: {
          viewBackgroundColor: boardViewBackground(transparentCanvas, theme.background),
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
    [theme.background, themeId, transparentCanvas, docPaper],
  );

  return (
    <div
      ref={boardRef}
      className={[
        "lc-board",
        !interactive && "lc-board-idle",
        // Reading: mute Excalidraw hit-testing so capture scroll always wins
        // (Gemini gatekeeper + CSS). Annotate restores normal canvas hits.
        interactive && !annotateCode && "lc-board-reading",
        interactive && annotateCode && "lc-board-annotating",
        transparentCanvas && "lc-board-paper",
        docPaper && "lc-board-doc-paper",
        // Highlighting / text-mark tools hand the surface back to the document
        // for the length of the gesture — see the rules in styles.css.
        (highlighting || textMarkSelecting) && "lc-board-highlighting",
        highlighting && "lc-board-sweep",
        textMarkSelecting && !highlighting && "lc-board-text-mark",
      ]
        .filter(Boolean)
        .join(" ")}
      /*
        The sweep band and the highlighter nib both wear the pen's colour, and
        both are styled in CSS — so the colour is published as a custom property
        rather than threaded through two component trees as a prop.
      */
      style={{ ["--lc-highlight" as string]: inkColor }}
    >
      {/*
        The markdown page, under everything.
        First in the DOM and on the lowest layer, so Excalidraw's shapes and the
        raster ink both draw over it. It is scaled, never reflowed — see
        `reportContentSlot`.
      */}
      {pageContent && (
        <div
          ref={contentSlotNodeRef}
          className={
            selectableContent && (!annotateCode || highlighting || textMarkSelecting)
              ? "lc-page-content-slot lc-page-content-selectable"
              : "lc-page-content-slot"
          }
          // Selectable prose is content, not decoration: hiding it from the
          // accessibility tree while the reader can pick quotes out of it would
          // be a lie. Annotate mode goes back to being paper under the pen.
          aria-hidden={
            selectableContent && (!annotateCode || highlighting || textMarkSelecting)
              ? undefined
              : true
          }
          style={{ width: contentSceneWidth }}
        >
          {pageContent}
        </div>
      )}
      {/*
        Footnote markers, over everything.

        Same transform as the page slot above (kept in step imperatively, since
        that one is moved per scroll frame), but above the ink layer — a mark is
        chrome about the page, and one buried under the writer's own strokes is
        a mark they cannot get back to. `pointer-events: none` on the layer so
        the pen still reaches the canvas through it; the markers themselves opt
        back in.
      */}
      {pageContent && (
        <div
          ref={attachMarksSlot}
          className="lc-page-marks-slot"
          style={{ width: contentSceneWidth }}
        />
      )}
      {linedPaperOn && linedSlotOn && (
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
              {annotateToggle && (chromeShown.chrome || annotatePeek) && (
                <div className="lc-map-chrome-row">
                  <button
                    type="button"
                    className={
                      annotateCode
                        ? "lc-lined-toggle lc-tip-target is-active"
                        : "lc-lined-toggle lc-tip-target"
                    }
                    aria-pressed={annotateCode}
                    aria-label={annotateCode ? "Hide toolbar" : "Show toolbar"}
                    data-tip={
                      annotateCode
                        ? "Toolbar on — tap to scroll the page"
                        : "Toolbar — annotate this page"
                    }
                    data-tip-placement="bottom"
                    onPointerDown={() => {
                      if (annotatePeek) peekAnnotate();
                    }}
                    onClick={toggleAnnotate}
                  >
                    <AnnotateIcon on={annotateCode} />
                  </button>
                </div>
              )}
              {annotateToggle && !chromeShown.chrome && !annotatePeek && (
                <button
                  type="button"
                  className={`${chromeWakeClass} lc-chrome-wake-annotate`}
                  aria-label="Show annotate mode"
                  data-tip={
                    chromeWakeMarker === "off" ? undefined : "Show annotate / scroll"
                  }
                  data-tip-placement="bottom"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    peekAnnotate();
                  }}
                  onClick={peekAnnotate}
                >
                  <span className="lc-chrome-wake-ghost" aria-hidden>
                    <AnnotateIcon on={annotateCode} />
                  </span>
                </button>
              )}
            </div>
            <div className="lc-board-dock">
              {/*
                Pager ABOVE the pen island. Grid uses align-items:end so Annotate /
                Eye / the dock share one bottom baseline; the island sits under
                the pager and grows the column upward instead of covering it.
                Snap slot stays between them so a redock lands under the pager,
                not on top of it.
              */}
              {!mapChromeHidden && bottomCenter}
              <div className="lc-toolbar-dock-anchor" aria-hidden />
              {!mapChromeHidden && annotateCode && (
              <div
                onPointerDownCapture={() => {
                  wakeChromeRef.current();
                }}
              >
              <BoardToolbar
                highlighting={highlighting}
                onToggleHighlight={
                  selectableContent ? () => setHighlighting((on) => !on) : undefined
                }
                inkPalette={inkPalette}
                onEditInkColor={(index, colour) => {
                  applyInkPaletteHistory(
                    setInkPaletteSlot(inkPaletteHistoryRef.current, index, colour),
                  );
                }}
                onCycleInkPaletteNext={cycleInkPaletteForward}
                onCycleInkPalettePrev={cycleInkPaletteBackward}
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
                straightInk={straightInk}
                onStraightInk={setStraightInkOn}
                onUndo={undoBoard}
                onRedo={redoBoard}
                mobile={mobile}
                onHeightChange={(height) => {
                  toolbarHeightRef.current = height;
                }}
                showColorWheel={presetStore.colorWheelOnToolbar}
                presetName={
                  wedgeAt(
                    presetStore,
                    kindFromTool(activeTool) ?? "pen",
                    presetStore.lastWedge[kindFromTool(activeTool) ?? "pen"],
                  )?.name ?? "Global"
                }
                presetColour={
                  (() => {
                    const kind = kindFromTool(activeTool) ?? "pen";
                    const snap = wedgeAt(presetStore, kind, presetStore.lastWedge[kind]);
                    if (!snap) return inkColor;
                    if (isEraserWedge(snap)) return "#f9a8d4";
                    return snap.colour;
                  })()
                }
                wheelLocked={presetStore.wheelLocked}
                onToggleWheelLock={() => {
                  const next = {
                    ...presetStore,
                    wheelLocked: !presetStore.wheelLocked,
                  };
                  setPresetStore(next);
                  saveInkToolPresets(next);
                }}
                onOpenInkWheel={() => setInkWheel("canvas")}
              />
              </div>
              )}
            </div>
            <div className="lc-map-chrome-right">
              {/*
                Right panel: Recentre, lined paper, theme, eye (sheet lock on
                mobile). One card. Annotate stays on the opposite end. Eye
                stays when chrome collapses; wake-dot is un-carded.
              */}
              <div
                className="lc-map-chrome-stack"
                role="toolbar"
                aria-label="Board view"
                onPointerDownCapture={
                  !chromeShown.eye
                    ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        wakeChrome();
                      }
                    : undefined
                }
              >
                {/*
                  The way back.

                  Even with the page frame locked and the context menu gone,
                  a board can end up somewhere the writer did not put it — a
                  pinch that got away, a restore that landed short. Everything
                  else on this stack is a preference; this is the one control
                  that exists so a board is never lost, and it is deliberately
                  one tap with nothing to read first.
                */}
                {!mapChromeHidden && (
                  <button
                    type="button"
                    className="lc-lined-toggle lc-tip-target"
                    aria-label="Recentre the board"
                    data-tip="Recentre the board"
                    data-tip-placement="bottom"
                    onClick={() => fitView()}
                  >
                    <RecentreIcon />
                  </button>
                )}
                {!mapChromeHidden &&
                  linedPaperToggle &&
                  isDrawPageRegion(mobileRegion ?? null) && (
                    <button
                      type="button"
                      className={
                        linedPaperMode !== "off"
                          ? "lc-lined-toggle lc-tip-target is-active"
                          : "lc-lined-toggle lc-tip-target"
                      }
                      aria-pressed={linedPaperMode !== "off"}
                      aria-label={linedPaperLabel(linedPaperMode)}
                      data-tip={linedPaperLabel(linedPaperMode)}
                      data-tip-placement="bottom"
                      onClick={() => {
                        const next = nextLinedPaperMode(linedPaperRef.current);
                        linedPaperRef.current = next;
                        setLinedPaperMode(next);
                        saveLinedPaperMode(next);
                        reflowReadingText();
                        requestAnimationFrame(reportLinedSlot);
                      }}
                    >
                      <span aria-hidden>🗒️</span>
                    </button>
                  )}
                {!mapChromeHidden && onThemePick && (
                  <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
                )}
                {!mapChromeHidden && mobile && onToggleSheetLock && (
                  <button
                    type="button"
                    className={[
                      "lc-lined-toggle lc-tip-target",
                      sheetDragLocked ? "is-active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-pressed={sheetDragLocked}
                    aria-label={
                      sheetDragLocked
                        ? "Unlock agent sheet drag-open"
                        : "Lock agent sheet against drag-open from the bottom"
                    }
                    data-tip={
                      sheetDragLocked
                        ? "Agent lock on — blocks drag-open from the bottom"
                        : "Lock agent sheet against drag-open from the bottom"
                    }
                    data-tip-placement="bottom"
                    onClick={onToggleSheetLock}
                  >
                    <LockIcon locked={sheetDragLocked} />
                  </button>
                )}
                {!mapChromeHidden && pageFilm && (
                  <button
                    type="button"
                    className={
                      pageFilm.open
                        ? "lc-lined-toggle lc-tip-target is-active"
                        : "lc-lined-toggle lc-tip-target"
                    }
                    aria-pressed={pageFilm.open}
                    aria-label={
                      pageFilm.open ? "Hide page previews" : "Show page previews"
                    }
                    data-tip={
                      pageFilm.open ? "Hide page previews" : "Show page previews"
                    }
                    data-tip-placement="bottom"
                    onClick={pageFilm.onToggle}
                  >
                    <PagesFilmIcon />
                  </button>
                )}
                {chromeShown.eye && (
                  <button
                    type="button"
                    className={
                      chromeMode === "visible"
                        ? "lc-chrome-eye lc-tip-target"
                        : "lc-chrome-eye lc-tip-target is-dimmed"
                    }
                    aria-pressed={chromeMode !== "hidden"}
                    aria-label={`Board controls: ${chromeModeLabel(chromeMode)}`}
                    data-tip={chromeModeLabel(chromeMode)}
                    data-tip-placement="bottom"
                    onClick={() => {
                      const next = nextChromeMode(chromeMode);
                      setChromeMode(next);
                      modeIndicatorRef.current?.show(chromeModeLabel(next));
                    }}
                  >
                    <EyeIcon closed={chromeMode === "hidden"} half={chromeMode === "fade"} />
                  </button>
                )}
                {/*
                  The column that brings it back.

                  Only mounted when there is nothing else there to tap, so it
                  never sits over a live control. Hit target is the whole
                  stack, not just the eye's square — with a pen up, a miss
                  used to stamp dots on the page.
                */}
                {!chromeShown.eye && (
                  <button
                    type="button"
                    className={chromeWakeClass}
                    aria-label="Show board controls"
                    data-tip={
                      chromeWakeMarker === "off" ? undefined : "Show controls"
                    }
                    data-tip-placement="bottom"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      wakeChrome();
                    }}
                    onClick={wakeChrome}
                  >
                    <span className="lc-chrome-wake-ghost" aria-hidden>
                      <EyeIcon closed />
                    </span>
                  </button>
                )}
              </div>
            </div>
            {coachFold}
          </div>
        </>
      )}
      {interactive && activeTool === "eraser" && <EraserBrush ref={eraserBrushRef} />}
      {interactive && <ModeIndicator ref={modeIndicatorRef} />}
      {interactive && <PadTitle ref={padTitleRef} />}
      {interactive && <PageIndicator ref={pageIndicatorRef} />}
      {interactive && (
        <ScrollBackHold
          boardRef={boardRef}
          onScrollBack={() => apiRef.current?.scrollToContent()}
        />
      )}
      <RasterInkLayer
        ref={rasterInkRef}
        enabled={interactive}
        tool={
          interactive && inkToolActive
            ? activeTool === "eraser"
              ? "eraser"
              : activeTool === "highlighter"
                ? "highlighter"
                : "pen"
            : null
        }
        strokeWidth={strokeWidth}
        inkColor={inkColor}
        inkFullness={inkFullness}
        pressureClip={pressureClip}
        smoothing={inkSmoothing}
        smoothingMode={inkSmoothingMode}
        straightInk={straightInk}
        speedInk={inkSpeed}
        speedBlotBlend={inkSpeedBlotBlend}
        inkBoldness={inkBoldness}
        partialErase={eraserPartial}
        pressureSensitive={pressureSensitive}
        getViewport={getViewport}
        getScrollHosts={getScrollHosts}
        getPageFrames={getPageFrames}
        clip={inkClip}
        onChange={handleInkChange}
        onStraightLine={commitStraightLine}
        onStylusAccessory={interactive ? handleStylusAccessory : undefined}
        wheelHoldEnabled={
          interactive && inkToolActive && !presetStore.wheelLocked
        }
        onWheelHold={(x, y) => setInkWheel({ x, y })}
      />
      {inkWheel && !(presetEditor && !wheelPeek) && (
        <InkToolWheel
          open
          locked={!!presetEditor}
          anchor={inkWheel}
          handedness={inkHandedness}
          store={presetStore}
          liveKind={kindFromTool(activeTool) ?? "pen"}
          onClose={() => setInkWheel(null)}
          onConfirm={(kind, wedge) => {
            applyInkWedge(kind, wedge);
            setTool(toolFromKind(kind));
            setInkWheel(null);
          }}
          onEdit={(kind, index, from) => {
            setPresetEditor({ kind, index, from });
            setWheelPeek(false);
          }}
        />
      )}
      {presetEditor && (
        <InkPresetEditor
          kind={presetEditor.kind}
          index={presetEditor.index}
          initial={wedgeAt(presetStore, presetEditor.kind, presetEditor.index)}
          fallback={wedgeAt(presetStore, presetEditor.kind, 0)}
          from={presetEditor.from}
          inkPalette={inkPalette}
          inkColor={inkColor}
          handedness={inkHandedness}
          onEditInkColor={(index, colour) => {
            applyInkPaletteHistory(
              setInkPaletteSlot(inkPaletteHistoryRef.current, index, colour),
            );
          }}
          onCycleNext={cycleInkPaletteForward}
          onCyclePrev={cycleInkPaletteBackward}
          onClose={(reason) => {
            setPresetEditor(null);
            setWheelPeek(false);
            if (reason !== "back") setInkWheel(null);
          }}
          onBackReveal={() => setWheelPeek(true)}
          onSave={(snap) => {
            let next = saveWedge(
              presetStoreRef.current,
              presetEditor.kind,
              presetEditor.index,
              snap,
            );
            next = applyWedge(next, presetEditor.kind, presetEditor.index);
            setPresetStore(next);
            syncInkFromPrefs();
            setPresetEditor(null);
            setWheelPeek(false);
            setInkWheel(null);
          }}
          onDuplicate={(snap) => {
            const copied = duplicateWedge(
              presetStoreRef.current,
              presetEditor.kind,
              presetEditor.index,
            );
            if (!copied) {
              const next = saveWedge(
                presetStoreRef.current,
                presetEditor.kind,
                presetEditor.index,
                snap,
              );
              setPresetStore(next);
              return;
            }
            setPresetStore(copied.store);
            setPresetEditor({
              kind: presetEditor.kind,
              index: copied.slot,
              from: presetEditor.from,
            });
          }}
        />
      )}
      <Excalidraw
        viewModeEnabled={!interactive || !annotateCode}
        handleKeyboardGlobally={interactive}
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExcalidrawApi;
          scrollUnsubRef.current?.();
          scrollUnsubRef.current =
            apiRef.current.onScrollChange?.((scrollX, scrollY) => {
              /*
               * Reading mode: column never moves sideways.
               *
               * Excalidraw's hand is 2D; we own vertical drag, but wheel /
               * clamp / stray pans can still nudge X. Pin every frame.
               */
              if (
                scrollModeRef.current &&
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
                !clampingScrollRef.current &&
                // A mid-drag rebase is our own bookkeeping catching the camera
                // up to where the finger already is — same trap as the clamp
                // above. Sampled, it reads as a frame the hand did not move and
                // damps the flick that follows.
                !committingScrollRef.current
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
              /*
               * A camera move nobody was riding — a fit, a pinch, a page turn —
               * ends any live pan translate. The slots below are about to be
               * re-reported at absolute coordinates and the ink repainted, so
               * an offset left over from a gesture would double every one of
               * them. A live gesture keeps its offsets: it clears them itself,
               * in the same frame it lands (see `landPanOffset`).
               */
              if (!liveCameraRef.current?.live) clearPanOffsetsRef.current();
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
                clampingScrollRef.current ||
                committingScrollRef.current ||
                inertiaFrameRef.current !== 0 ||
                liveCameraRef.current?.live
              ) {
                return;
              }
              const bounds = pageBoundsRef.current;
              const api = apiRef.current;
              if (!bounds || !api) return;
              const state = api.getAppState() as {
                width?: number;
                height?: number;
                zoom?: { value?: number };
              };
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
                state.zoom?.value ?? 1,
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
          apiRef.current.setActiveTool({ type: "hand" });
          if (!annotateCodeRef.current) {
            ensureReadingHand();
          }
          reportCodeSlot();
        }}
        onChange={handleSceneChange}
        initialData={initialData}
        UIOptions={UI_OPTIONS}
      />
      {interactive && activeTool === "text" && <TextPlaceGhost ref={textPlaceGhostRef} />}
      {interactive && stampTrash && (
        <button
          ref={attachStampTrash}
          type="button"
          className="lc-stamp-trash"
          style={
            stampTrashPosRef.current
              ? {
                  left: stampTrashPosRef.current.left,
                  top: stampTrashPosRef.current.top,
                }
              : undefined
          }
          aria-label="Delete selection"
          title="Delete"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => deleteSelection()}
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

function LockIcon({ locked = false }: { locked?: boolean }) {
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
      <rect x="5" y="11" width="14" height="10" rx="2" />
      {locked ? (
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      ) : (
        <path d="M8 11V8a4 4 0 0 1 7.5-1" />
      )}
    </svg>
  );
}

/** Crosshair in a frame — "put the page back where it belongs". */
function RecentreIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function EyeIcon({ closed = false, half = false }: { closed?: boolean; half?: boolean }) {
  if (half) {
    // Fade mode: the same eye, lidded. Not the crossed-out one — the controls
    // are still there, they just do not stay.
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
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

function PagesFilmIcon() {
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
      <rect x="4" y="7" width="11" height="14" rx="1.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4H19a1.5 1.5 0 0 1 1.5 1.5V17A1.5 1.5 0 0 1 19 18.5h-4" />
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
