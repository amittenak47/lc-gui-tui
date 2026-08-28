/**
 * Which PDF page a conflict row is about.
 *
 * Footnotes store a scope (`p7`, `page-1`), not a viewer page number. Ink
 * uses `page_id`. The split preview needs one 1-based page for both panes.
 */

import type { InkPageDto } from "../api/client";
import type { DocFootnote } from "./docFootnotes";

/** `p7`, `page-1`, `page_2`, or a bare number. Chapter hrefs are not pages. */
export function pageFromScope(scope?: string | null): number | null {
  if (!scope) return null;
  const trimmed = scope.trim();
  if (!trimmed) return null;
  const prefixed = /^(?:page[-_]?|p)(\d+)$/i.exec(trimmed);
  if (prefixed) return Math.max(1, Number(prefixed[1]));
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number(trimmed));
  return null;
}

export function pageFromNote(note: DocFootnote | null | undefined): number | null {
  if (!note) return null;
  return pageFromScope(note.anchor?.scope);
}

export function firstInkPage(
  pages: readonly InkPageDto[] | undefined,
  fallback?: number,
): number {
  if (fallback != null && fallback >= 1) return fallback;
  const first = pages?.find((page) => page.page_id >= 1)?.page_id;
  return first != null && first >= 1 ? first : 1;
}

/** Page to show for the focused row. Same PDF bytes in both panes. */
export function conflictFocusPage(opts: {
  note?: DocFootnote | null;
  inkPageId?: number;
  ink?: readonly InkPageDto[];
}): number {
  const fromNote = pageFromNote(opts.note ?? null);
  if (fromNote) return fromNote;
  return firstInkPage(opts.ink, opts.inkPageId);
}
