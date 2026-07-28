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

/**
 * What the *student* put on the board: their own shapes, stamps and typed text,
 * with the seeded template (anything carrying `lcRegion`) and the coach's
 * diagrams removed.
 *
 * This is the submit gate's question — "is there anything of theirs here?" —
 * and it is not the same as "is there recognized text?", because a browser
 * build has no handwriting OCR at all.
 */
export function studentAuthoredElements(
  elements: readonly SceneElementLike[],
): SceneElementLike[] {
  return studentElements(elements).filter((el) => !el.customData?.lcRegion);
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

/** Truncated id → Excalidraw version, for structure deltas. */
export function captureVersions(elements: readonly SceneElementLike[]): Map<string, number> {
  return new Map(
    studentElements(elements).map((el) => [truncateCaptureId(el.id), el.version]),
  );
}

/** Longest edge of the board PNG, in pixels, before it is base64'd. */
export const CAPTURE_MAX_EDGE = 1600;

/**
 * Give up on the image rather than the review. A board that is still this large
 * after downscaling is a pathological export; the coach gets the structure and
 * the text instead of a request the daemon will refuse to buffer.
 */
export const CAPTURE_MAX_BASE64 = 12 * 1024 * 1024;

/**
 * Shrink an exported board so it fits in a request body.
 *
 * The full-size export of a doubled whiteboard runs to tens of megabytes, which
 * is what pushed `POST /coach/review` past the daemon's body limit. Returns the
 * original blob when it is already small enough, or when the environment has no
 * canvas to draw into (tests, workers).
 */
export async function shrinkImageBlob(blob: Blob, maxEdge: number): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return blob;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= maxEdge) {
    bitmap.close?.();
    return blob;
  }
  const scale = maxEdge / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  // PNG, not JPEG: the daemon labels the attachment `data:image/png`.
  const shrunk = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return shrunk ?? blob;
}

/**
 * Image extractor. `exportToBlob` is passed in rather than imported so this
 * module stays free of Excalidraw and the caller has to make the deliberate
 * choice to spend a vision model's tokens.
 *
 * Returns `""` when the result is still too large to send — the caller treats a
 * missing PNG as "review without the picture", never as a failure.
 */
export async function captureImage(
  exportToBlob: () => Promise<Blob>,
  options: { maxEdge?: number; maxBase64?: number } = {},
): Promise<string> {
  const original = await exportToBlob();
  const blob = await shrinkImageBlob(original, options.maxEdge ?? CAPTURE_MAX_EDGE);
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const limit = options.maxBase64 ?? CAPTURE_MAX_BASE64;
  // 4 base64 chars per 3 bytes — check before spending the encode.
  if (Math.ceil(bytes.length / 3) * 4 > limit) return "";
  let binary = "";
  const CHUNK = 0x8000; // Avoid blowing the argument limit on large boards.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
