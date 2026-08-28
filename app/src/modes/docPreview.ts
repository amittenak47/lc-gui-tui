/**
 * How much of a very large document is actually drawn on the paper.
 *
 * The annotate page is not a viewer: it lays out at full content height inside
 * the board's page frame and rides the camera, with no inner scroller. That is
 * what keeps ink on the words — and it means the whole file becomes DOM. The
 * accepted source limit is 1.5 million characters, which at that point is a
 * parse, a sanitise and a DOM tree big enough to freeze the open and every
 * later toggle between Annotate and Scroll.
 *
 * So above a threshold the paper shows the beginning of the file and says so.
 * The full text is still stored, still indexed, still what search and the agent
 * read; it is only the drawing that stops. Virtualising instead would be a
 * different product — a camera-synced page has no viewport to virtualise
 * against — and is deliberately not attempted here.
 */

/** Above this many characters, only the first {@link DOC_PREVIEW_MAX_CHARS} are drawn. */
export const DOC_PREVIEW_MAX_CHARS = 80_000;

/**
 * Above this many characters, parse after the first paint instead of during it.
 *
 * Below it the work is a few milliseconds and doing it inline keeps an ordinary
 * note's open exactly as it was — one render, one measurement, no placeholder
 * frame in between.
 */
export const DOC_PARSE_INLINE_MAX_CHARS = 20_000;

export interface DocPreview {
  /** The text to render. The whole source, unless it was too long. */
  text: string;
  /** Characters left undrawn. Zero when the whole file is on the page. */
  hidden: number;
}

/** Cut a very long source down to what the paper will draw. */
export function docPreview(source: string): DocPreview {
  if (source.length <= DOC_PREVIEW_MAX_CHARS) return { text: source, hidden: 0 };
  /*
   * Cut at a line break so the last thing drawn is a whole line — mid-word is
   * ugly, and mid-fence or mid-tag would leave the parser holding an unclosed
   * block that swallows the notice underneath it.
   */
  const cut = source.lastIndexOf("\n", DOC_PREVIEW_MAX_CHARS);
  const end = cut > DOC_PREVIEW_MAX_CHARS / 2 ? cut : DOC_PREVIEW_MAX_CHARS;
  return { text: source.slice(0, end), hidden: source.length - end };
}

/** Whether this source is small enough to parse during render. */
export function parseInline(text: string): boolean {
  return text.length <= DOC_PARSE_INLINE_MAX_CHARS;
}

/**
 * The line at the foot of a truncated page.
 *
 * Authored here, not derived from the document, so there is nothing to escape
 * but a number — and it is appended after sanitising for the same reason.
 */
export function truncationNoticeHtml(hidden: number): string {
  if (hidden <= 0) return "";
  const thousands = Math.round(hidden / 1000);
  const amount = thousands >= 1 ? `${thousands}k more characters` : `${hidden} more characters`;
  return (
    `<p class="lc-doc-truncated" role="note">` +
    `This file is long, so the page shows the beginning of it — ${amount} ` +
    `are stored and searchable but not drawn here.</p>`
  );
}
