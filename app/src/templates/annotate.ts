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

import { READING_COLUMN_MAX, READING_COLUMN_MIN, readingColumnWidth } from "./readingColumn";
import type { Skeleton } from "./skeleton";

export const ANNOTATE_TASK_ID = "__annotate__";
/** Pre-rename task id. Still recognised when restoring an old session. */
export const LEGACY_MD_INK_TASK_ID = "__md_ink__";
/** Wire `surface` for any captured source (file now, URL later). */
export const ANNOTATE_DATASET = "annotate";

/**
 * Region id the camera fits to — one page, so one id.
 *
 * Value stays `mdink-0`: it is persisted as `customData.lcRegion` on saved
 * boards, and renaming it would orphan every annotated document.
 */
export const ANNOTATE_REGION = "mdink-0";

/**
 * Scene width of the document page — a reading column, not a desk.
 *
 * {@link ANNOTATE_PAGE_W} is the *ceiling* (Obsidian's `--file-line-width`
 * default). On a phone, fitting that ceiling to ~400 CSS px used to render
 * body text near 8px — unreadable. New sessions size the page to the viewport
 * instead so width-fit lands near zoom 1 and type stays Obsidian-sized. The
 * ceiling still applies on a tablet, so the column does not stretch into a
 * desktop-wide measure.
 *
 * Annotations are stored in scene coordinates against whatever width the page
 * had when they were drawn. Changing width under existing ink reflows the
 * markdown and leaves marks on the wrong words — so restores with ink keep
 * their saved frame width.
 */
export const ANNOTATE_PAGE_W = READING_COLUMN_MAX;

/** Narrowest column we will author — below this, chrome eats the prose. */
export const ANNOTATE_PAGE_W_MIN = READING_COLUMN_MIN;

/**
 * Page width for a fresh markdown session on this screen.
 *
 * The problem statement is set the same way now, so the arithmetic lives in
 * {@link readingColumnWidth} and both documents share it.
 */
export function annotatePageWidthForViewport(cssWidth: number): number {
  return readingColumnWidth(cssWidth);
}

/** Width stamped on a saved md-ink frame, if any. */
export function annotateFrameWidthFromElements(
  elements: readonly { width?: number; customData?: { lcMdInkFrame?: boolean } | null }[],
): number | null {
  for (const el of elements) {
    if (!el?.customData?.lcMdInkFrame) continue;
    if (typeof el.width === "number" && Number.isFinite(el.width) && el.width > 0) {
      return Math.round(el.width);
    }
  }
  return null;
}

/**
 * Column width for an annotate open.
 *
 * Fresh files follow the viewport so type stays readable. A restore keeps
 * the width the marks and ink were drawn at — rotate only changes zoom, and
 * landscape-open used to overwrite that width so region boxes sat off the
 * words. Prefer the saved frame, then a stored sidecar width, then the screen.
 */
export function annotatePageWidthForOpen(
  viewportCssWidth: number,
  saved?: {
    elements?: readonly {
      width?: number;
      customData?: { lcMdInkFrame?: boolean } | null;
    }[] | null;
    frameWidth?: number | null;
  } | null,
): number {
  const fromElements = saved?.elements
    ? annotateFrameWidthFromElements(saved.elements)
    : null;
  if (fromElements != null) return fromElements;
  const stored = saved?.frameWidth;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return Math.round(stored);
  }
  return annotatePageWidthForViewport(viewportCssWidth);
}

/** Height before the document has been measured, and the floor afterwards. */
export const MD_INK_MIN_PAGE_H = 1100;

/**
 * Scene units per CSS pixel of rendered markdown.
 *
 * The document layer is laid out at {@link ANNOTATE_PAGE_W} scene units wide and
 * scaled by the camera, so one CSS pixel in the renderer *is* one scene unit.
 * Kept as a named constant because the height that comes back from the measure
 * is in those units and the arithmetic reads like nonsense without a name for
 * the identity.
 */
export const MD_INK_SCENE_PER_PX = 1;

/** Room under the last line so a note can be written past the end of the text. */
export const MD_INK_TAIL_PAD = 180;

export function annotatePageHeight(measuredPx: number | null): number {
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
export function buildAnnotateTemplate(
  height: number,
  _dark = false,
  width: number = ANNOTATE_PAGE_W,
): Skeleton[] {
  const pageW = Math.round(
    Number.isFinite(width) && width > 0
      ? Math.min(ANNOTATE_PAGE_W, Math.max(ANNOTATE_PAGE_W_MIN, width))
      : ANNOTATE_PAGE_W,
  );
  return [
    {
      id: "lcmdink-0-frame",
      type: "rectangle",
      x: 0,
      y: 0,
      width: pageW,
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
      /*
       * Locked: an unlocked document-tall frame can be selected, and Excalidraw
       * then paints marching-ants around the whole page. On a long markdown file
       * that selection box is as tall as the document and is redrawn every scroll
       * frame — the lag the writer sees as the dashed box on the screen edge.
       */
      locked: true,
      angle: 0,
      customData: {
        lcRegion: ANNOTATE_REGION,
        lcRegionFrame: true,
        lcMdInkFrame: true,
        lcDocumentPage: true,
      },
    },
  ];
}
