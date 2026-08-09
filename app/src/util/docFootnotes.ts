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

import { isRegionAnchor, isTextAnchor, normalizeAnchor, type DocAnchor } from "./docAnchors";

export type DocFootnoteKind = "coach" | "search" | "note";

const FOOTNOTE_KINDS: ReadonlySet<DocFootnoteKind> = new Set([
  "coach",
  "search",
  "note",
]);

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
  /**
   * A crop of the page under a region mark, as a base64 PNG.
   *
   * A text footnote can always say what it points at by re-reading the words.
   * A region on a scanned page cannot, so the picture is the excerpt — it is
   * what the ribbon shows on tap and what the coach is sent.
   */
  png?: string;
  /** Search: what was asked, and where it was asked. */
  query?: string;
  url?: string;
}

/**
 * Same words (or same rectangle), same place.
 *
 * Two anchors are the same place when they name the same span of the same
 * scope. Regions compare on their rectangle, rounded to the pixel — a
 * highlighter sweep is never re-drawn to sub-pixel precision, and treating a
 * half-pixel difference as a new mark is how a page ends up with a stack of
 * ribbons the reader cannot tell apart.
 */
function samePlace(a: DocAnchor, b: DocAnchor): boolean {
  if (a.scope !== b.scope) return false;
  if (isTextAnchor(a) && isTextAnchor(b)) return a.start === b.start && a.end === b.end;
  if (isRegionAnchor(a) && isRegionAnchor(b)) {
    return (
      Math.round(a.x) === Math.round(b.x) &&
      Math.round(a.y) === Math.round(b.y) &&
      Math.round(a.w) === Math.round(b.w) &&
      Math.round(a.h) === Math.round(b.h)
    );
  }
  return false;
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
    (existing) => existing.kind !== entry.kind || !samePlace(existing.anchor, entry.anchor),
  );
  return [...kept, entry].sort(sortByPosition);
}

export function removeFootnote(
  footnotes: readonly DocFootnote[],
  id: string,
): DocFootnote[] {
  return footnotes.filter((entry) => entry.id !== id);
}

/**
 * Reading order — which is also numbering order.
 *
 * Scope first, then position inside it. Scopes sort by the order the renderer
 * declared them (see {@link orderScopes}); without that, page 10 would come
 * before page 2 and the numbers on the page would run backwards.
 */
let scopeOrder: ReadonlyMap<string, number> = new Map();

/**
 * Tell the sort what order this document's pages are in.
 *
 * Called by the layer that knows — the renderer's own scope roots, in document
 * order. Global rather than threaded through every call because sorting is used
 * from a comparator, and one document is open at a time.
 */
export function orderScopes(scopes: readonly string[]): void {
  scopeOrder = new Map(scopes.map((scope, index) => [scope, index]));
}

function scopeRank(scope: string | undefined): number {
  if (!scope) return -1;
  return scopeOrder.get(scope) ?? Number.MAX_SAFE_INTEGER;
}

/** Where a mark sits inside its scope, for ordering. Regions sort by their top. */
function positionIn(footnote: DocFootnote): number {
  return isTextAnchor(footnote.anchor) ? footnote.anchor.start : footnote.anchor.y;
}

function sortByPosition(a: DocFootnote, b: DocFootnote): number {
  const rankA = scopeRank(a.anchor.scope);
  const rankB = scopeRank(b.anchor.scope);
  if (rankA !== rankB) return rankA - rankB;
  const scopeA = a.anchor.scope ?? "";
  const scopeB = b.anchor.scope ?? "";
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;
  const posA = positionIn(a);
  const posB = positionIn(b);
  if (posA !== posB) return posA - posB;
  // Two marks at the same spot: oldest first, so a number does not move when a
  // second one is added beside it.
  return a.createdAt - b.createdAt;
}

/**
 * The number shown on each ribbon, by position in the document.
 *
 * Continuous across the whole document rather than restarting per page: the
 * number is a handle for talking about a mark ("look at 12"), and one that
 * repeats on every page is not a handle. Derived rather than stored, so
 * deleting note 3 renumbers what follows instead of leaving a hole.
 */
export function numberFootnotes(
  footnotes: readonly DocFootnote[],
): Map<string, number> {
  const ordered = [...footnotes].sort(sortByPosition);
  return new Map(ordered.map((entry, index) => [entry.id, index + 1]));
}

/** Drop anything that is not a footnote, for reading untrusted stored JSON. */
export function sanitizeFootnotes(value: unknown): DocFootnote[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry): DocFootnote[] => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Partial<DocFootnote>;
      if (typeof candidate.id !== "string") return [];
      if (!FOOTNOTE_KINDS.has(candidate.kind as DocFootnoteKind)) return [];
      // Anchors written before regions existed carry no `kind` — normalising
      // here is what keeps an old library entry from being silently dropped.
      const anchor = normalizeAnchor(candidate.anchor);
      if (!anchor) return [];
      return [{ ...(candidate as DocFootnote), anchor }];
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
