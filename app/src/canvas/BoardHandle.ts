/**
 * What the rest of the app is allowed to know about the canvas.
 *
 * Everything above this line — the modes, the viz applier, the ambient loop —
 * talks to `BoardHandle`, never to Excalidraw. That is the mitigation for the
 * plan's top risk: if ink latency in a WebView turns out to be intolerable on
 * the Magic Note Pad, a raw-canvas ink layer composited under Excalidraw
 * implements this same interface and nothing else changes.
 */

import type { Skeleton } from "../templates/skeleton";
import type { InkStroke, SceneElementLike } from "./capture";

export type ToolName = "selection" | "freedraw" | "eraser" | "text" | "rectangle" | "ellipse" | "arrow";

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
  /** Base64 PNG of the board, for vision-capable models only. */
  exportPng(): Promise<string>;
  /** Freedraw strokes in absolute coordinates, for the ink recognizer. */
  getStrokes(): InkStroke[];
  setTool(tool: ToolName): void;
  undo(): void;
  scrollToContent(): void;
}
