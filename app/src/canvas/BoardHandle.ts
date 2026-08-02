/**
 * What the rest of the app is allowed to know about the canvas.
 *
 * Everything above this line — the modes, the viz applier, the ambient loop —
 * talks to `BoardHandle`, never to Excalidraw. That is the mitigation for the
 * plan's top risk: if ink latency in a WebView turns out to be intolerable on
 * the Magic Note Pad, a raw-canvas ink layer composited under Excalidraw
 * implements this same interface and nothing else changes.
 */

import type { RegionId } from "../templates/regions";
import type { Skeleton } from "../templates/skeleton";
import type { InkStroke, SceneElementLike } from "./capture";
import type { InkOp } from "./rasterInk";

export interface BoardBlob {
  v: 1;
  elements: unknown[];
  appState: { scrollX: number; scrollY: number; zoom: number };
  /** Raster pen/eraser ops — optional for older saves. */
  ink?: InkOp[];
  /** Excalidraw binary files (images) keyed by file id. */
  files?: Record<string, BoardBinaryFile>;
}

/** Persisted image binary — mirrors Excalidraw BinaryFileData fields we need. */
export interface BoardBinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export type ToolName =
  | "hand"
  | "selection"
  | "freedraw"
  | "eraser"
  | "text"
  | "rectangle"
  | "ellipse"
  | "arrow";

/** Screen-space rectangle relative to the board container. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Excalidraw zoom — Monaco must scale fonts with this (HTML doesn't). */
  zoom: number;
}

export interface BoardHandle {
  /** Live scene elements, including the coach's — callers filter. */
  getElements(): SceneElementLike[];
  /** Replace the whole element list. Used by the viz applier. */
  setElements(elements: unknown[]): void;
  /** Turn skeletons into real elements without touching the scene. */
  convert(skeletons: Skeleton[]): unknown[];
  /** Lay down a fresh template, discarding whatever was on the board. */
  seedTemplate(skeletons: Skeleton[]): void;
  /** Restore the original problem template layout (frames + statement). */
  resetTemplate(): void;
  /**
   * Base64 PNG of the board, raster pen ink included, for vision models only.
   * Export uses scene bounds — viewport zoom does not change what the coach sees.
   */
  exportPng(): Promise<string>;
  /**
   * True when the bitmap ink layer holds strokes. Pen ink is pixels, not scene
   * elements, so this is the only way to know handwriting exists on a browser
   * build where nothing OCRs it.
   */
  hasRasterInk(): boolean;
  /** Freedraw strokes in absolute scene coordinates, for the ink recognizer. */
  getStrokes(): InkStroke[];
  /**
   * Raster pen strokes in scene coordinates, for the ink recognizer. Separate
   * from {@link getStrokes} because the pen writes pixels, not `freedraw`
   * elements — both sources have to reach ML Kit or handwriting goes unread.
   * Scene coords are zoom-independent: writing while zoomed in is the same size
   * to the coach as writing while zoomed out.
   */
  getInkStrokes(): InkStroke[];
  /** Committed raster ink ops — for ambient/review fingerprints. */
  getInkOpCount(): number;
  /** Replace raster ink (notebook restore after the ink layer has mounted). */
  setInkOps(ops: InkOp[]): void;
  setTool(tool: ToolName): void;
  undo(): void;
  scrollToContent(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Re-center the viewport on the current page (or problem+code on desktop). */
  fitView(): void;
  /** Grow/shrink the focus frame to the chrome hole without resetting zoom. */
  fitFrame(): void;
  /** Resize the page frame and refit zoom/scroll to fill the board (window resize). */
  refitToViewport(): void;
  /** Fit one template region to the viewport — the mobile "page turn". */
  fitRegion(regionId: RegionId | string): void;
  /**
   * Append one blank scratchpad page and return its 0-based index.
   * No-op helper for problem boards — callers should only use this in scratchpad.
   */
  appendScratchPage(skeletons: Skeleton[]): number;
  /** Fit after layout has settled (double rAF + short delays). Resolves when
   * the final fit has been applied — call while the board is still hidden.
   */
  settleFitView(): Promise<void>;
  /** Wait until every seeded region frame is present in the scene. */
  waitForTemplate(): Promise<void>;
  /** Grow/shrink the code frame so Monaco can show this source without scrolling. */
  fitCodeToSource(source: string): void;
  /** Small PNGs of student template boxes that have content (for chat attachments). */
  exportRegionThumbs(): Promise<Array<{ region: RegionId; label: string; png: string }>>;
  /** Persistable board blob (excludes coach viz; includes raster ink). */
  saveBoard(): BoardBlob;
  /** Restore a saved board without recording undo history. */
  restoreBoard(
    elements: unknown[],
    appState?: unknown,
    options?: { skeletons?: Skeleton[]; ink?: InkOp[]; files?: Record<string, BoardBinaryFile> },
  ): void;
  /** Recolor template scaffolding for the current theme (after restore/seed). */
  applyThemeInk(themeId: string): void;
  /** Drop all coach viz elements — used before re-applying from chat drawings. */
  stripCoachViz(): void;
}
