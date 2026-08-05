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

import type { Skeleton } from "./skeleton";

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
 * taken out, which is Obsidian's own `--file-line-width` default.
 *
 * The page is fitted to the viewport's *width* — a document scrolls its height
 * rather than shrinking to it — so on a tablet held upright (~820 CSS px) this
 * lands at roughly 1.08x: the body renders near 16px, which is the size a
 * mobile reader shows, and the column fills the screen.
 *
 * The measure is ~93 characters, above the 50-75 usually called ideal for
 * prose. That is the same measure Obsidian puts on an iPad, and it is fixed
 * here for a harder reason than taste: annotations are stored in scene
 * coordinates against this column. Change the width — or the body size — and
 * the text reflows underneath ink that does not, so every mark on every saved
 * document slides off the words it was drawn on. The column is part of the
 * document's contract once anything has been written on it.
 *
 * The known cost is a phone, where fitting 760 to ~400px renders the body near
 * 8px. Sizing the page to the viewport would fix that and break the contract
 * above, so it needs a per-document stored width rather than a constant.
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
export function buildMdInkTemplate(height: number, _dark = false): Skeleton[] {
  return [
    {
      id: "lcmdink-0-frame",
      type: "rectangle",
      x: 0,
      y: 0,
      width: MD_INK_PAGE_W,
      height,
      /*
       * Invisible on purpose.
       *
       * The frame still has to exist — it is what the camera fits to, what the
       * pan clamp bounds against, and what the ink is clipped to — but a dashed
       * template box drawn around somebody's notes is a sheet of paper's idea
       * of itself. A document has no edge; it has a column and an end. So the
       * element stays and its stroke goes.
       */
      strokeColor: "transparent",
      backgroundColor: "transparent",
      strokeStyle: "solid",
      strokeWidth: 0,
      roughness: 0,
      opacity: 0,
      locked: false,
      angle: 0,
      customData: {
        lcRegion: MD_INK_REGION,
        lcRegionFrame: true,
        lcMdInkFrame: true,
        lcDocumentPage: true,
      },
    },
  ];
}
