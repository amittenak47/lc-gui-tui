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
 * Scene width of the document page — a reading column, not a desk.
 *
 * This was the scratchpad's 3920, matched so a nib covered the same fraction of
 * the page in both modes. That reasoning was about the pen and ignored the
 * reader: a page that wide, fitted to a tablet held upright, renders body text
 * at a size you cannot read without zooming, and once zoomed you are panning a
 * document instead of reading one. It was a desktop layout on a device nobody
 * holds like a desktop.
 *
 * 760 leaves a 700px text column once the document's 30px side padding is
 * taken out, which is Obsidian's own `--file-line-width` default. That is the
 * basis for the number — not a character count.
 *
 * Be honest about what that measures: at the 15px body this renders, 700px is
 * roughly 93 characters a line, which is above the 50–75 usually called ideal
 * for prose and well above the 30–50 quoted for phones. It is, however, what
 * Obsidian itself puts on screen, and the two cannot both be satisfied here.
 * The page is fitted to the viewport, so column width and apparent text size
 * are locked together — narrowing to 70 characters would fit a ~585 page and
 * render the body near 26px on a tablet, which is large enough to look like an
 * accessibility setting rather than a document. Matching Obsidian and letting
 * the writer zoom is the better of the two.
 *
 * The measure does not change when they do: characters per line is fixed by
 * this width against the font size, and the camera scales both together.
 */
export const MD_INK_PAGE_W = 760;

/** Height before the document has been measured, and the floor afterwards. */
export const MD_INK_MIN_PAGE_H = 1100;

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
export const MD_INK_TAIL_PAD = 180;

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
