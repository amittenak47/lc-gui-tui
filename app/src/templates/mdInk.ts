/**
 * The page a markdown document is annotated on.
 *
 * One frame, no chrome, no title, no pager — the document supplies all of that
 * itself. The frame exists for two reasons only: it is what the mobile
 * fit/visibility path aims the camera at (`lcRegion`), and it is what the ink
 * clip is measured against. Its height is not a constant: it grows to whatever
 * the markdown measures, because a page that ends before the text does would
 * clip ink off the bottom of a long document.
 */

import { templatePalette, type Skeleton } from "./skeleton";

export const MD_INK_TASK_ID = "__md_ink__";
export const MD_INK_DATASET = "md-ink";

/** Region id the camera fits to — one page, so one id. */
export const MD_INK_REGION = "mdink-0";

/**
 * Scene width of the document page.
 *
 * Matches the scratchpad page so a stroke of a given nib size covers the same
 * fraction of the page in both modes — the pen should not feel like a different
 * pen because the paper underneath it is a different mode.
 */
export const MD_INK_PAGE_W = 3920;

/** Height before the document has been measured, and the floor afterwards. */
export const MD_INK_MIN_PAGE_H = 2400;

/**
 * Scene units per CSS pixel of rendered markdown.
 *
 * The document layer is laid out at {@link MD_INK_PAGE_W} scene units wide and
 * scaled by the camera, so one CSS pixel in the renderer *is* one scene unit.
 * Kept as a named constant because the height that comes back from the measure
 * is in those units and the arithmetic reads like nonsense without a name for
 * the identity.
 */
export const MD_INK_SCENE_PER_PX = 1;

/** Room under the last line so a note can be written past the end of the text. */
export const MD_INK_TAIL_PAD = 320;

export function mdInkPageHeight(measuredPx: number | null): number {
  if (measuredPx === null || !Number.isFinite(measuredPx) || measuredPx <= 0) {
    return MD_INK_MIN_PAGE_H;
  }
  return Math.max(MD_INK_MIN_PAGE_H, measuredPx * MD_INK_SCENE_PER_PX + MD_INK_TAIL_PAD);
}

/**
 * The page frame.
 *
 * Unlocked, like the scratchpad's, so the existing region machinery can move
 * and measure it — the *markdown* is what is locked, and it is HTML under the
 * canvas rather than an element on it, so there is nothing here to lock.
 */
export function buildMdInkTemplate(height: number, dark = false): Skeleton[] {
  const ink = templatePalette(dark);
  return [
    {
      id: "lcmdink-0-frame",
      type: "rectangle",
      x: 0,
      y: 0,
      width: MD_INK_PAGE_W,
      height,
      strokeColor: ink.border,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      strokeWidth: 2,
      roughness: 0,
      opacity: 100,
      locked: false,
      angle: 0,
      customData: {
        lcRegion: MD_INK_REGION,
        lcRegionFrame: true,
        lcMdInkFrame: true,
      },
    },
  ];
}
