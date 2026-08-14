/**
 * What the floating trash is allowed to remove.
 *
 * The control used to appear only when the selection held a library stamp, so a
 * rectangle the reader drew themselves could be selected, moved and resized but
 * not deleted — and the tablet this is written on has no keyboard, so nothing
 * else on screen would remove it either.
 *
 * Its own module because it is a pure question about one element, and because
 * importing `Board` to ask it drags Excalidraw in behind it.
 */

/** The shape of a scene element as the selection trash needs to read it. */
export interface TrashEl {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Linear elements (arrow, line) carry their shape here, relative to x/y. */
  points?: readonly (readonly [number, number])[];
  isDeleted?: boolean;
  locked?: boolean;
  customData?: {
    lcStamp?: boolean;
    lcStampGroup?: string;
    lcRegion?: string;
    lcRegionFrame?: boolean;
    lcMdInkFrame?: boolean;
  } | null;
}

/**
 * Is this the reader's, or the page's?
 *
 * The trash removes things that were put on the board. Region frames, their
 * labels and the document frame are the page itself — the layout the template
 * laid out and the rest of the app measures against — so removing one does not
 * tidy the board, it breaks the page. Locked elements are excluded for the same
 * reason and are not selectable anyway; a stamp that loaded locked is unlocked
 * on mount, so nothing the reader placed is caught by that clause.
 */
export function isDeletableElement(el: TrashEl): boolean {
  if (el.locked) return false;
  const meta = el.customData;
  if (meta?.lcRegionFrame || meta?.lcRegion || meta?.lcMdInkFrame) return false;
  return !el.id.startsWith("lcregion-");
}

/* ------------------------------------------------------------- placement --- */

/** Button edge in CSS px — must match `.lc-stamp-trash` in styles.css. */
export const TRASH_SIZE_PX = 34;

/** Clear air between the button and the selection it belongs to. */
export const TRASH_GAP_PX = 8;

/** A selection's extent in scene units. */
export interface TrashBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TrashCamera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** The board's own box in CSS px — what the button must stay inside. */
export interface TrashViewport {
  width: number;
  height: number;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Scene-space extent of everything about to be deleted.
 *
 * A linear element — an arrow, a line — carries its shape in `points` relative
 * to `x`/`y`, and Excalidraw does not always normalise `width`/`height` to the
 * drawn extent while the element is still being edited. Reading the points when
 * they are there is what makes the trash land on the corner of an arrow rather
 * than near where the arrow started.
 */
export function selectionBounds(els: readonly TrashEl[]): TrashBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of els) {
    const points = el.points;
    if (points && points.length > 0) {
      for (const [px, py] of points) {
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        minX = Math.min(minX, el.x + px);
        minY = Math.min(minY, el.y + py);
        maxX = Math.max(maxX, el.x + px);
        maxY = Math.max(maxY, el.y + py);
      }
      continue;
    }
    // A negative width is a box drawn right-to-left; normalise so the "max"
    // corner really is the far one.
    const w = num(el.width, 0);
    const h = num(el.height, 0);
    minX = Math.min(minX, el.x, el.x + w);
    minY = Math.min(minY, el.y, el.y + h);
    maxX = Math.max(maxX, el.x, el.x + w);
    maxY = Math.max(maxY, el.y, el.y + h);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Scene copies Excalidraw still has at the last commit, plus the clones it
 * holds while a transform is in flight.
 *
 * A move or a linear-point drag often mutates `draggingElement` /
 * `resizingElement` without bumping the scene array or `version` until
 * pointer-up. Bounds that only read `getSceneElements()` then stay where the
 * shape started, which is why the trash used to jump after the gesture ended.
 */
export function withLiveTrashEls(
  els: readonly TrashEl[],
  live: ReadonlyArray<TrashEl | null | undefined>,
): TrashEl[] {
  const byId = new Map<string, TrashEl>();
  for (const el of els) byId.set(el.id, el);
  for (const patch of live) {
    if (!patch?.id) continue;
    byId.set(patch.id, patch);
  }
  return Array.from(byId.values());
}

/**
 * Where the delete button goes, in CSS px from the board's top-left.
 *
 * **Outside the selection, not on it.** It used to sit 36px in from the right
 * edge and 40px up, which put it over the top-right corner of whatever was
 * selected — so the control that deletes a thing covered the thing, and on a
 * small shape it covered most of it. The corner it wants is diagonally out:
 * clear to the right, clear above.
 *
 * That corner is not always on screen, so there are fallbacks, in the order a
 * hand would look for the button: outside top-right, then outside bottom-right
 * when the selection is against the top of the board, then outside top-left
 * when it is against the right edge. Only if none of those fit does it clamp
 * into the viewport, which can overlap the selection — at that point the
 * selection fills the board and there is no clear air anywhere.
 */
export function trashAnchor(
  bounds: TrashBounds,
  camera: TrashCamera,
  viewport: TrashViewport,
): { left: number; top: number } {
  const zoom = camera.zoom || 1;
  const left = (bounds.minX + camera.scrollX) * zoom;
  const right = (bounds.maxX + camera.scrollX) * zoom;
  const top = (bounds.minY + camera.scrollY) * zoom;
  const bottom = (bounds.maxY + camera.scrollY) * zoom;

  const outRight = right + TRASH_GAP_PX;
  const outLeft = left - TRASH_GAP_PX - TRASH_SIZE_PX;
  const outAbove = top - TRASH_GAP_PX - TRASH_SIZE_PX;
  const outBelow = bottom + TRASH_GAP_PX;

  const fitsRight = outRight + TRASH_SIZE_PX <= viewport.width;
  const fitsAbove = outAbove >= 0;

  let x: number;
  let y: number;
  if (fitsRight && fitsAbove) {
    x = outRight;
    y = outAbove;
  } else if (fitsRight && outBelow + TRASH_SIZE_PX <= viewport.height) {
    x = outRight;
    y = outBelow;
  } else if (outLeft >= 0 && fitsAbove) {
    x = outLeft;
    y = outAbove;
  } else {
    x = outRight;
    y = outAbove;
  }

  return {
    left: Math.round(Math.max(0, Math.min(viewport.width - TRASH_SIZE_PX, x))),
    top: Math.round(Math.max(0, Math.min(viewport.height - TRASH_SIZE_PX, y))),
  };
}
