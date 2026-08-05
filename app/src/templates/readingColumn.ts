/**
 * How wide a page is when the page is something you *read*.
 *
 * Two pages in this app are documents rather than sheets of paper: the markdown
 * file and the problem statement. Both are set in scene units and then scaled
 * to the screen by a width-only camera fit, which makes the frame's scene width
 * the thing that decides how big the type comes out — fit zoom is
 * `viewport / frameWidth`, so a 3920-unit column on a 400px phone renders its
 * 36-unit body text at 3.6 CSS px. That is the whole reason the statement was
 * unreadable: nothing was wrong with the font, the column was four screens wide.
 *
 * So a reading page sizes its column to the viewport. Fit zoom lands near 1,
 * scene units come out as CSS pixels, and the measure stays in the 35–70
 * characters-per-line range a document is set in — narrow on a phone, capped on
 * a tablet so it never stretches into a desktop-wide line.
 */

/** Ceiling — Obsidian's `--file-line-width` default. */
export const READING_COLUMN_MAX = 760;
/** Floor — below this, page inset eats the prose. */
export const READING_COLUMN_MIN = 300;

/**
 * Column width for a reading page on a viewport this wide.
 *
 * `cssWidth` is the board's content width (or `window.innerWidth` before the
 * board has mounted).
 */
export function readingColumnWidth(cssWidth: number): number {
  if (!Number.isFinite(cssWidth) || cssWidth < 1) return READING_COLUMN_MAX;
  // A little inset so the column is not flush with the bezel — a document has
  // gutters, and edge-bleed type reads as a zoomed-out desktop page.
  const inset = cssWidth < 640 ? 24 : 32;
  const usable = cssWidth - inset * 2;
  return Math.round(Math.min(READING_COLUMN_MAX, Math.max(READING_COLUMN_MIN, usable)));
}

/**
 * Side inset between a region frame and the text inside it.
 *
 * Wide drawing frames keep the authored 36 units; a reading column scales it
 * down so a phone-width page does not spend a fifth of its measure on margins.
 */
export function regionTextInset(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 36;
  return Math.max(16, Math.min(36, Math.round(width * 0.05)));
}

/** Usable text width inside a frame of this width. */
export function regionTextWidth(width: number): number {
  return Math.max(120, Math.round(width - regionTextInset(width) * 2));
}

/**
 * Authored scene font for statement prose, in reading-column units.
 *
 * The old template authored at 28 because the column was 3920 units wide.
 * A reading column is roughly one screen wide, so its scene units are roughly
 * CSS pixels and the authored size is a real type size. `applyBoardReadingSize`
 * replaces this with the S/M/L size; it survives as the base the code/prose
 * ratio is measured against.
 */
export const STATEMENT_PROSE_BASE = 18;
/** Examples, constraints, anything with brackets — the monospace face. */
export const STATEMENT_CODE_BASE = 15;
/**
 * Reading-column font bases stay inside this range; anything else is legacy.
 *
 * The ceiling is deliberately below the old template's 24/28: those are the
 * bases boards were saved with when the column was four screens wide, and
 * taking them at face value would set the whole statement 50% large and lose
 * the prose/monospace distinction into the ratio clamp.
 */
export const STATEMENT_BASE_RANGE: readonly [number, number] = [11, 22];
