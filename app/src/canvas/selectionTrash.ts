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
