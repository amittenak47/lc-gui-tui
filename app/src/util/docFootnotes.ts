/**
 * Footnotes — the marks a reading session leaves on the page.
 *
 * A selection that went somewhere (a coach thread, a web search) drops a small
 * sticker ribbon at the words it came from. Tapping it later reopens what it
 * led to. That is the whole model: a footnote is a pointer from a place in the
 * document to a place outside it, and the reason it is worth persisting is that
 * the outside thing — a thread three days old, a search you would have to
 * remember the wording of — is otherwise unreachable from the page it is about.
 *
 * Copy deliberately leaves no footnote. Nothing was created to point at, and a
 * page dotted with markers for "I copied this once" is a page you stop reading.
 *
 * Stored with the document rather than in a global preference: a footnote is
 * about *these* words, and follows the annotation set that owns them.
 */

import type { DocAnchor } from "./docAnchors";

export type DocFootnoteKind = "coach" | "search";

export interface DocFootnote {
  id: string;
  kind: DocFootnoteKind;
  /** Where in the document the mark sits. */
  anchor: DocAnchor;
  /** The words it was made from — shown when the anchor no longer resolves. */
  excerpt: string;
  createdAt: number;
  /** Coach: the thread this quote opened. */
  threadRootId?: string;
  /** Search: what was asked, and where it was asked. */
  query?: string;
  url?: string;
}

/** Ids are per-document, so a timestamp with a collision guard is enough. */
export function freshFootnoteId(existing: readonly DocFootnote[], now = Date.now()): string {
  const base = `fn-${now.toString(36)}`;
  if (!existing.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!existing.some((entry) => entry.id === candidate)) return candidate;
  }
}

/**
 * Add a footnote, replacing any of the same kind on the same words.
 *
 * Asking the coach twice about one sentence is a normal thing to do while
 * reading, and it should leave one ribbon pointing at the newer thread rather
 * than two stacked ribbons the writer has to tell apart by pixel. Different
 * kinds on the same words do coexist — a search and a thread are two different
 * places to go back to.
 */
export function addFootnote(
  footnotes: readonly DocFootnote[],
  entry: DocFootnote,
): DocFootnote[] {
  const kept = footnotes.filter(
    (existing) =>
      existing.kind !== entry.kind ||
      existing.anchor.scope !== entry.anchor.scope ||
      existing.anchor.start !== entry.anchor.start ||
      existing.anchor.end !== entry.anchor.end,
  );
  return [...kept, entry].sort(sortByPosition);
}

export function removeFootnote(
  footnotes: readonly DocFootnote[],
  id: string,
): DocFootnote[] {
  return footnotes.filter((entry) => entry.id !== id);
}

/** Reading order: scope first, then position in it. */
function sortByPosition(a: DocFootnote, b: DocFootnote): number {
  const scopeA = a.anchor.scope ?? "";
  const scopeB = b.anchor.scope ?? "";
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;
  return a.anchor.start - b.anchor.start;
}

/** Drop anything that is not a footnote, for reading untrusted stored JSON. */
export function sanitizeFootnotes(value: unknown): DocFootnote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is DocFootnote => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<DocFootnote>;
      if (typeof candidate.id !== "string") return false;
      if (candidate.kind !== "coach" && candidate.kind !== "search") return false;
      const anchor = candidate.anchor;
      if (!anchor || typeof anchor !== "object") return false;
      if (typeof anchor.start !== "number" || typeof anchor.end !== "number") return false;
      return anchor.end > anchor.start;
    })
    .sort(sortByPosition);
}

/** Google Search URL for a quote — the query is the words, nothing added. */
export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * A quote long enough to be a paragraph is not a search.
 *
 * Google truncates past roughly 32 words anyway, and a whole paragraph pasted
 * into a search box returns the document it came from at best. The first clause
 * is what someone would actually have typed.
 */
export function searchQueryFor(text: string, maxWords = 24): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}
