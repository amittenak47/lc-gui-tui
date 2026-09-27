/**
 * Pages for documents that have none: text, code, markdown, EPUB.
 *
 * A PDF brings its own pages. Everything else is one tall column, so Pages
 * reading cuts it into view-sized pieces — never through the middle of a
 * line. Blocks (paragraphs, headings, list items, code blocks, tables…) are
 * packed top to bottom and a page ends before the first block that would not
 * fit. A block taller than a whole page (a long code listing) is the one
 * thing that has to be split, and it is split on its own line height so each
 * page still ends between two lines.
 */

import type { PageFrame } from "../inkPageIndex";

export interface TextBlock {
  /** Scene Y of the block's top and bottom. */
  top: number;
  bottom: number;
  /** Scene height of one line inside it, for splitting blocks taller than a page. */
  lineHeight: number;
}

/** A page is never shorter than this much of the view, so tiny blocks cannot make slivers. */
const MIN_FILL = 0.35;

export function sectionPages(
  blocks: readonly TextBlock[],
  pageHeight: number,
  start: number,
  end: number,
): PageFrame[] {
  if (!(pageHeight > 0) || !(end > start)) return [];
  const sorted = blocks
    .filter((block) => block.bottom > block.top && block.bottom > start && block.top < end)
    .sort((a, b) => a.top - b.top);
  const frames: PageFrame[] = [];
  let pageTop = start;
  const close = (at: number) => {
    if (at <= pageTop) return;
    frames.push({ pageId: frames.length + 1, minY: pageTop, maxY: at });
    pageTop = at;
  };
  for (const block of sorted) {
    if (block.bottom - pageTop <= pageHeight) continue;
    // Break before the block, unless that leaves a sliver of a page.
    if (block.top > pageTop && block.top - pageTop >= pageHeight * MIN_FILL) {
      close(block.top);
      if (block.bottom - pageTop <= pageHeight) continue;
    }
    // Still too tall: split inside it, between lines.
    const line = block.lineHeight > 0 ? block.lineHeight : pageHeight;
    while (block.bottom - pageTop > pageHeight) {
      const room = pageTop + pageHeight - Math.max(pageTop, block.top);
      const lines = Math.max(1, Math.floor(room / line));
      const cut = Math.max(pageTop, block.top) + lines * line;
      if (cut <= pageTop) break;
      close(Math.min(cut, end));
    }
  }
  close(end);
  return frames;
}
