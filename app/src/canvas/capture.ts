/**
 * Turning a scene into something a text-only model can read.
 *
 * Two extractors, per the plan:
 *
 * - **structure** — `getSceneElements()` stripped to `{type, x, y, w, h, text}`.
 *   Typed text comes free; handwriting needs {@link ../canvas/ink}.
 * - **image** — `exportToBlob()` → PNG, only when a vision-capable model is
 *   selected. Held behind {@link captureImage} so the caller has to opt in.
 *
 * These functions take a structural element type rather than Excalidraw's own,
 * so they stay pure and testable without pulling in a DOM.
 */

/** The subset of an Excalidraw element these extractors read. */
export interface SceneElementLike {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
  text?: string;
  points?: ReadonlyArray<readonly [number, number]>;
  customData?: { lcRegion?: string; lcVizId?: string } | null;
}

/** Truncate Excalidraw ids for the coach prompt (STRUCTURE_CLIP budget). */
export const CAPTURE_ID_LEN = 8;

export function truncateCaptureId(id: string): string {
  return id.length <= CAPTURE_ID_LEN ? id : id.slice(0, CAPTURE_ID_LEN);
}

/** One element as the coach sees it. */
export interface CapturedElement {
  /** Truncated stable id — the model may cite this in highlight_student_work. */
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  /** Which board region it landed in, when the template defines one. */
  region?: string;
}

export interface InkStroke {
  points: Array<{ x: number; y: number }>;
}

/**
 * Elements the coach should read: the student's own, minus anything deleted.
 *
 * The agent lane is excluded deliberately — feeding the coach's own injected
 * diagrams back to it as if the student had drawn them makes it agree with
 * itself and drift away from what is actually on the board.
 */
export function studentElements(elements: readonly SceneElementLike[]): SceneElementLike[] {
  return elements.filter((el) => !el.isDeleted && !el.customData?.lcVizId);
}

/** Structure extractor. Coordinates are rounded — sub-pixel noise is not signal. */
export function captureStructure(elements: readonly SceneElementLike[]): CapturedElement[] {
  return studentElements(elements).map((el) => {
    const captured: CapturedElement = {
      id: truncateCaptureId(el.id),
      type: el.type,
      x: Math.round(el.x),
      y: Math.round(el.y),
      w: Math.round(el.width),
      h: Math.round(el.height),
    };
    if (el.text && el.text.trim().length > 0) captured.text = el.text;
    if (el.customData?.lcRegion) captured.region = el.customData.lcRegion;
    return captured;
  });
}

/** Resolve truncated capture ids back to live scene elements (prefix match). */
export function resolveCaptureIds(
  elements: readonly SceneElementLike[],
  ids: readonly string[],
): SceneElementLike[] {
  const live = studentElements(elements);
  const found: SceneElementLike[] = [];
  for (const raw of ids) {
    const prefix = truncateCaptureId(raw);
    const match = live.find(
      (el) => el.id === raw || el.id.startsWith(prefix) || truncateCaptureId(el.id) === prefix,
    );
    if (match && !found.some((el) => el.id === match.id)) found.push(match);
  }
  return found;
}

/** Typed text, in reading order, so it can be merged with recognized ink. */
export function captureTypedText(elements: readonly SceneElementLike[]): string {
  return studentElements(elements)
    .filter((el) => typeof el.text === "string" && el.text.trim().length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((el) => el.text!.trim())
    .join("\n");
}

/**
 * Freedraw strokes in absolute page coordinates, for the ink recognizer.
 * Excalidraw stores `points` relative to the element's origin.
 */
export function captureStrokes(elements: readonly SceneElementLike[]): InkStroke[] {
  return studentElements(elements)
    .filter((el) => el.type === "freedraw" && el.points && el.points.length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((el) => ({
      points: el.points!.map(([dx, dy]) => ({
        x: Math.round(el.x + dx),
        y: Math.round(el.y + dy),
      })),
    }));
}

/**
 * Fingerprint of the board, from element ids and Excalidraw's own version
 * counters. Equal hashes mean nothing was drawn, moved, or erased — which is
 * how the ambient loop avoids paying for an unchanged board.
 *
 * 32-bit FNV-1a: the daemon takes a `u64`, and collisions at this width are
 * irrelevant for a "did anything change" check.
 */
export function sceneHash(elements: readonly SceneElementLike[]): number {
  let hash = 0x811c9dc5;
  for (const el of studentElements(elements)) {
    for (const chunk of [el.id, ":", String(el.version), ";"]) {
      for (let i = 0; i < chunk.length; i++) {
        hash ^= chunk.charCodeAt(i);
        // FNV prime, via shifts to stay in 32-bit int range.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
      }
    }
  }
  return hash >>> 0;
}

/**
 * How much new work there is since the last analysed board. The ambient loop
 * skips when this is small, so a single stray dot doesn't trigger a round trip.
 */
export function strokeDelta(
  elements: readonly SceneElementLike[],
  previousIds: ReadonlySet<string>,
): number {
  return studentElements(elements).filter((el) => !previousIds.has(el.id)).length;
}

export function elementIds(elements: readonly SceneElementLike[]): Set<string> {
  return new Set(studentElements(elements).map((el) => el.id));
}

/**
 * Image extractor. `exportToBlob` is passed in rather than imported so this
 * module stays free of Excalidraw and the caller has to make the deliberate
 * choice to spend a vision model's tokens.
 */
export async function captureImage(
  exportToBlob: () => Promise<Blob>,
): Promise<string> {
  const blob = await exportToBlob();
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // Avoid blowing the argument limit on large boards.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
