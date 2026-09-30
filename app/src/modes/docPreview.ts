/**
 * When a document's parse leaves the render path.
 *
 * The annotate page is not a viewer: it lays out at full content height inside
 * the board's page frame and rides the camera, with no inner scroller. That is
 * what keeps ink on the words — and it means the whole file becomes DOM, all
 * of it drawn. A very large file is a parse and a sanitise big enough to freeze
 * the frame that opens it, so above a threshold that work waits for the first
 * paint, behind a placeholder.
 */

/**
 * Above this many characters, parse after the first paint instead of during it.
 *
 * Below it the work is a few milliseconds and doing it inline keeps an ordinary
 * note's open exactly as it was — one render, one measurement, no placeholder
 * frame in between.
 */
export const DOC_PARSE_INLINE_MAX_CHARS = 20_000;

/** Whether this source is small enough to parse during render. */
export function parseInline(text: string): boolean {
  return text.length <= DOC_PARSE_INLINE_MAX_CHARS;
}
