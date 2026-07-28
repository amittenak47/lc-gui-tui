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
  /** Erase the student's work, keeping the template scaffolding. */
  clearStudentWork(): void;
  /** Restore the original problem template layout (frames + statement). */
  resetTemplate(): void;
  /** Base64 PNG of the board, raster pen ink included, for vision models only. */
  exportPng(): Promise<string>;
  /**
   * True when the bitmap ink layer holds strokes. Pen ink is pixels, not scene
   * elements, so this is the only way to know handwriting exists on a browser
   * build where nothing OCRs it.
   */
  hasRasterInk(): boolean;
  /** Freedraw strokes in absolute coordinates, for the ink recognizer. */
  getStrokes(): InkStroke[];
  /**
   * Raster pen strokes in scene coordinates, for the ink recognizer. Separate
   * from {@link getStrokes} because the pen writes pixels, not `freedraw`
   * elements — both sources have to reach ML Kit or handwriting goes unread.
   */
  getInkStrokes(): InkStroke[];
  setTool(tool: ToolName): void;
  undo(): void;
  scrollToContent(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Re-center the viewport on the current page (or problem+code on desktop). */
  fitView(): void;
  /** Fit one template region to the viewport — the mobile "page turn". */
  fitRegion(regionId: RegionId): void;
  /**
   * Fit after layout has settled (double rAF + short delays). Resolves when
   * the final fit has been applied — call while the board is still hidden.
   */
  settleFitView(): Promise<void>;
  /** Grow/shrink the code frame so Monaco can show this source without scrolling. */
  fitCodeToSource(source: string): void;
  /** Persistable board blob (excludes coach viz). */
  saveBoard(): { v: 1; elements: unknown[]; appState: { scrollX: number; scrollY: number; zoom: number } };
  /** Restore a saved board without recording undo history. */
  restoreBoard(
    elements: unknown[],
    appState?: unknown,
    options?: { skeletons?: Skeleton[] },
  ): void;
}
