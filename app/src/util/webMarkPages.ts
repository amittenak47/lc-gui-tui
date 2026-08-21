/**
 * A web page's index, built from what the reader marked.
 *
 * Every other kind of document was deliberately opened, so all of it is worth
 * indexing. A page is not: it is mostly navigation, promotion and script-built
 * furniture, and indexing the lot buries the paragraph you cared about in
 * chrome. What you meant is what you drew a selection block around — which is
 * the whole reason the live view had to work first. Browse the page properly,
 * freeze it, mark the passage, and only that passage becomes searchable.
 *
 * ## Why marks are merged rather than mapped one to one
 *
 * `chunk_pages` on the Rust side emits one chunk per page entry when the entry
 * fits, and an excerpt has no minimum size. One entry per mark would therefore
 * turn a hundred marks into a hundred chunks, some of them five words long, and
 * a five-word chunk is a poor retrieval unit twice over: it matches narrowly,
 * and when it *is* retrieved it hands the model almost no context to reason
 * from. Retrieval takes four chunks and caps the lot at 4000 characters, so
 * four tiny ones would spend four of the model's slots on a few dozen words.
 *
 * Consecutive marks are therefore filled into groups up to a chunk's worth. The
 * alternative — carrying surrounding page text with each mark — retrieves
 * better still, but puts unmarked page back into the index, which is the thing
 * this exists to keep out.
 */

/** Mirrors `CHUNK_CHARS` in `src/docs_index.rs`; one group is meant to be one chunk. */
export const MARK_GROUP_CHARS = 2400;

export interface MarkLike {
  /** The words the mark was made from. */
  excerpt?: string;
}

export interface MarkPage {
  page: number;
  text: string;
}

/**
 * Group marks into chunk-sized runs, in the order they were made.
 *
 * Empty marks are dropped; a mark longer than the budget stands alone rather
 * than being cut, since splitting an excerpt splits its meaning.
 */
export function webPagesFromMarks(
  marks: readonly MarkLike[],
  budget = MARK_GROUP_CHARS,
): MarkPage[] {
  const excerpts = marks
    .map((mark) => (mark.excerpt ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);
  if (excerpts.length === 0) return [];

  const pages: MarkPage[] = [];
  let current: string[] = [];
  let running = 0;
  const flush = () => {
    if (current.length === 0) return;
    pages.push({ page: pages.length + 1, text: current.join("\n\n") });
    current = [];
    running = 0;
  };
  for (const text of excerpts) {
    // +2 for the blank line that will join them.
    if (current.length > 0 && running + text.length + 2 > budget) flush();
    current.push(text);
    running += text.length + 2;
  }
  flush();
  return pages;
}
