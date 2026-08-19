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
import type { EncodedInk } from "./inkCodec";
import type { InkOp } from "./rasterInk";

export interface BoardBlob {
  /**
   * Blob format, and deliberately still `1` now that ink is encoded.
   *
   * Five readers hard-compare `board.v === 1` and drop the entry when it does
   * not match, so bumping this would make every library filter out every board
   * saved by the new build — silently, since a filtered entry looks exactly
   * like a library that never had it. The ink encoding announces itself with
   * its own field instead, and both are read forever.
   */
  v: 1;
  elements: unknown[];
  appState: { scrollX: number; scrollY: number; zoom: number };
  /** Raster pen/eraser ops as written before the codec — still read, never written. */
  ink?: InkOp[];
  /**
   * The same ops, encoded — see `inkCodec`. Read board ink through
   * `inkOpsFrom(blob)` rather than either field.
   */
  inkC?: EncodedInk;
  /**
   * Per-page shard manifest. Live autosave may omit a full `inkC` and keep
   * pages in the `ink_pages` store; readers load shards first, then `inkC`.
   */
  inkPages?: { v: 1; pageIds: number[] };
  /** Excalidraw binary files (images) keyed by file id. */
  files?: Record<string, BoardBinaryFile>;
  /**
   * Ink colour-wheel history for this annotation.
   * Optional on older saves — restore seeds the theme default palette.
   */
  inkPalettes?: { items: string[][]; index: number };
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
  /** Wide translucent chisel — see `HIGHLIGHT_WIDTH_SCALE` in rasterInk. */
  | "highlighter"
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
  convert(skeletons: Skeleton[], opts?: { regenerateIds?: boolean }): unknown[];
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
  /**
   * Scene point → layout viewport, using the live camera (split-pane offsets).
   * Null when Excalidraw has no appState yet.
   */
  sceneToClient(x: number, y: number): { x: number; y: number } | null;
  /** Committed raster ink ops — for ambient/review fingerprints. */
  getInkOpCount(): number;
  /**
   * The pen or eraser tip is on the paper right now.
   *
   * For callers that do expensive work on a timer: serialising the board means
   * walking every ink point on the page, and doing that under the nib is felt
   * as the stroke stopping. Wait for the lift.
   */
  isInking(): boolean;
  /** Replace raster ink (notebook restore after the ink layer has mounted). */
  setInkOps(ops: InkOp[]): void;
  ingestInkPages(pages: Map<number, EncodedInk>): void;
  takeDirtyInkPages(): Map<number, EncodedInk>;
  markInkPagesFlushed(pageIds: Iterable<number>): void;
  dirtyInkPageCount(): number;
  encodedInkShards(): EncodedInk[];
  assembleEncodedInk(): EncodedInk;
  /**
   * Say something briefly over the board, then let it go.
   *
   * Center ModeIndicator toast — Annotation / Scroll mode. ScratchPad open
   * uses {@link showPadTitle} instead (top-left movie bold).
   */
  announce(label: string): void;
  /**
   * ScratchPad-only title: top-left of the pad, movie-bold fade.
   * Never used for Problem / Constraints / Code / md-ink open.
   */
  showPadTitle(label: string): void;
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
  /**
   * Write the live board box onto Excalidraw and keepY-fit.
   *
   * Split / sash / unpark — `refresh()` does not resize the canvas, so a
   * pointer used to be required before the pane looked right.
   */
  nudgeViewportFit(): void;
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
  /**
   * One PNG of what the reader is looking at right now.
   *
   * The narrow half of Annotate. A whole board is the right thing to send when
   * the question is about the shape of the work; it is the wrong thing when the
   * question is about one figure on page forty, where every other crop is
   * context the model has to rule out before it can answer. Cropped to the
   * viewport in scene coordinates, so it is exactly what the writer could see
   * when they asked. Null when there is no camera to read.
   */
  exportViewThumb(): Promise<{ label: string; png: string } | null>;
  /**
   * PNG of one coach diagram, cropped to the group it drew.
   *
   * The post-draw review asks a vision model whether the picture says what the
   * program claims, so it needs the picture *as rendered* — not the whole
   * board, where the diagram would be a few hundred pixels in a corner.
   * Empty string when that group is not on the board.
   */
  exportVizPng(programId: string): Promise<string>;
  /** Persistable board blob (excludes coach viz; includes raster ink). */
  saveBoard(opts?: { assembleInk?: boolean }): BoardBlob;
  /** Restore a saved board without recording undo history. */
  restoreBoard(
    elements: unknown[],
    appState?: unknown,
    options?: {
      skeletons?: Skeleton[];
      ink?: InkOp[];
      files?: Record<string, BoardBinaryFile>;
      inkPalettes?: { items: string[][]; index: number };
      /** Skip the post-restore fit — caller will size the frame then restoreView. */
      skipFit?: boolean;
    },
  ): void;
  /**
   * Jump the camera so a 1-based PDF page sits under the chrome.
   * No-op when that page is not in the document slot.
   */
  scrollToPdfPage(pageId: number): void;
  /**
   * Reopen camera: PDF jumps to the saved page at today's fit zoom;
   * single-page docs restore scroll/zoom as written.
   */
  restoreView(saved: { scrollX: number; scrollY: number; zoom: number }): void;
  /** Recolor template scaffolding for the current theme (after restore/seed). */
  applyThemeInk(themeId: string): void;
  /** Drop all coach viz elements — used before re-applying from chat drawings. */
  stripCoachViz(): void;
  /**
   * Force reading-mode scroll arming after a document opens.
   * Toolbar toggle used to be required — this is that toggle, without the UI.
   */
  armReadingScroll(): void;
}
