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

import {
  isRegionAnchor,
  isTextAnchor,
  normalizeAnchor,
  type DocAnchor,
  type TextAnchor,
} from "./docAnchors";
import type { LocalRect } from "./docMarquee";
import { normalizePalette } from "./inkPaletteHistory";

export type DocFootnoteKind = "coach" | "search" | "note" | "ai";

const FOOTNOTE_KINDS: ReadonlySet<DocFootnoteKind> = new Set([
  "coach",
  "search",
  "note",
  "ai",
]);

export interface DocFootnoteUserLink {
  title?: string;
  url: string;
}

/**
 * One note on a mark — an entry, not a field.
 *
 * A single text box per footnote made the reader edit one growing blob: adding
 * a second thought meant finding the end of the first and hoping the box was
 * tall enough. Entries are how notes are actually written — one thing at a
 * time, kept separately, deletable on their own.
 */
export interface DocFootnoteNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A coach conversation this mark has led to.
 *
 * `rootId` is the id of the message the thread hangs off, which is the handle
 * the transcript already uses ({@link visibleThreadMessages} takes exactly
 * this). The title is stored rather than always derived because a thread can
 * outlive the messages kept in memory, and a row in the list that cannot say
 * what it is about is a row nobody taps.
 */
export interface DocFootnoteThread {
  rootId: string;
  title: string;
  createdAt: number;
}

export interface DocFootnote {
  id: string;
  kind: DocFootnoteKind;
  /** Where in the document the mark sits. */
  anchor: DocAnchor;
  /** The words it was made from — shown when the anchor no longer resolves. */
  excerpt: string;
  createdAt: number;
  /**
   * When the reader last changed this mark — a colour, a title, a note, a link.
   *
   * `DocFootnoteNote` has carried both timestamps from the start; the mark that
   * owns them only ever recorded its birth. That is the one annotation property
   * nothing can reconstruct afterwards: a creation time is stored, but a
   * modification time is simply gone unless it was written down when it
   * happened.
   *
   * Absent on marks written before this existed, and left that way until one of
   * them is actually edited — inventing a modification time would be worse than
   * admitting there is not one.
   */
  updatedAt?: number;
  /**
   * Coach: the thread this quote opened — the first one, kept as the ribbon's
   * identity. Everything the reader has asked since lives in {@link threads},
   * which includes this one.
   */
  threadRootId?: string;
  /** Every coach conversation started from this mark, oldest first. */
  threads?: DocFootnoteThread[];
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
  /** Writer notes in the footnote overview card, oldest first. */
  notes?: DocFootnoteNote[];
  /** Extra links the writer saved on the overview card. */
  userLinks?: DocFootnoteUserLink[];
  /**
   * The ribbon's colour, chosen from a palette on the overview card.
   *
   * One value, not three: the edge and the label are derived from it in CSS
   * where the rest of the theming lives, so a stored colour cannot drift out of
   * step with how a ribbon is drawn. Absent means the default — a document
   * whose marks are all one colour is the normal case, and colouring them is
   * for when a reader wants to mean something by it.
   */
  color?: string;
  /**
   * The four (or more) swatches this mark's colour wheel owns.
   *
   * Snapshotted at create from the ColorHunt fallback list so cycling or
   * editing one hub does not retint the others. Absent = older marks that
   * still borrow a fallback set from their live ribbon number until the
   * writer first cycles.
   */
  palette?: string[];
  /**
   * Optional short label for coach chips (`2. MyTitle`).
   *
   * Absent = chips show the number alone. Not the excerpt: that text is already
   * on the page, and a chip that quotes it is too wide to scan.
   */
  title?: string;
  /**
   * Content-block boxes under the selection (body-local), for region chrome.
   *
   * When present, the page paints these instead of the full marquee rectangle
   * so the mark hugs paragraphs / pre / figures. Absent = older footnotes that
   * only stored the rubber-band region.
   */
  bands?: LocalRect[];
  /**
   * Full text under the selection (not the clamped excerpt).
   *
   * The overview panel shows this as the collapsible block quote; sub-marks
   * index into it. Absent = older footnotes that only stored `excerpt`.
   */
  blockText?: string;
  /**
   * Narrower underline / highlight marks inside {@link blockText}.
   */
  subMarks?: DocFootnoteSubMark[];
}

export type DocFootnoteSubMarkKind = "underline" | "highlight";

/**
 * A narrower underline / highlight inside a parent mark.
 *
 * `anchor` is where it lives on the page; `start` / `end` index into
 * {@link DocFootnote.blockText} when that field is present for coach context.
 */
export interface DocFootnoteSubMark {
  id: string;
  kind: DocFootnoteSubMarkKind;
  /** Slice of {@link DocFootnote.blockText} / excerpt. */
  excerpt: string;
  /** Inclusive start offset into the block text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Live page anchor when the sub-mark was made on the document. */
  anchor?: TextAnchor;
  /**
   * This underline's picked swatch. Absent on older sub-marks that still
   * inherit the parent mark's colour.
   */
  color?: string;
  /**
   * Wheel this underline owns. Snapshotted so cycling one line does not
   * retint the others. Absent = inherit the parent mark until first cycle.
   */
  palette?: string[];
}

/** `#rgb` or `#rrggbb`, which is all a palette ever produces. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** Coach chip / picker label: `2.` or `2. MyTitle`. */
export function footnoteChipLabel(number?: number, title?: string): string {
  const n = number != null ? `${number}.` : "";
  const t = title?.replace(/\s+/g, " ").trim();
  if (n && t) return `${n} ${t}`;
  if (n) return n;
  if (t) return t;
  return "Mark";
}

/** Gap between a mark and its number chip. */
export const MARK_CHIP_PAD_PX = 3;

/**
 * Where a user mark's number chip goes, in page-local x.
 *
 * The page's outer margin, on the side the mark is on — the way a printed book
 * puts a margin note. Not beside the mark, which is where this went first: on a
 * two-column paper the space to the right of a left-column mark is the *gutter*,
 * about eleven pixels of it, and a sixteen-pixel chip in an eleven-pixel gutter
 * lands on the first letter of the other column. There is no arrangement that
 * fits it there. The margins are the only space on a page that is reliably
 * empty, and they are also where a reader already looks for a marginal number.
 *
 * Before that it was inset inside the mark's own block, which only looked right
 * by accident — a short heading's block ends mid-column, so the chip fell in the
 * whitespace beside it; mark a full column and it came down on the last word of
 * the first line, and a mark spanning the page put its number in the page's
 * top-right corner.
 */
export function markChipLeft(input: {
  blockLeft: number;
  blockRight: number;
  pageWidth: number;
  chipWidth: number;
  pad?: number;
}): number {
  const pad = input.pad ?? MARK_CHIP_PAD_PX;
  const { blockLeft, blockRight, pageWidth, chipWidth } = input;
  if (pageWidth > 0) {
    const onLeftHalf = (blockLeft + blockRight) / 2 < pageWidth / 2;
    /*
     * Beside the block, not at the edge of the paper.
     *
     * These are the same place on a document whose text fills its page, which
     * is why the difference did not show up until a captured web page: there the
     * content is a narrow column with hundreds of pixels of empty page either
     * side, so "in the page margin" put the chip so far from the words it
     * belonged to that the two no longer read as connected.
     *
     * Still the mark's *own* side first, and still never the gutter — a
     * two-column paper leaves about eleven pixels between the columns, which a
     * chip cannot occupy without landing on the first letter of the next one.
     * Hugging the block on its own side cannot reach that gutter: a left-column
     * mark hugs leftward into the left margin, a right-column mark rightward
     * into the right one.
     */
    const hugLeft = blockLeft - chipWidth - pad;
    const hugRight = blockRight + pad;
    const fitsLeft = hugLeft >= 0;
    const fitsRight = hugRight + chipWidth <= pageWidth;
    if (onLeftHalf && fitsLeft) return hugLeft;
    if (!onLeftHalf && fitsRight) return hugRight;
    // No room that side — try the other before giving up on margins at all.
    if (!onLeftHalf && fitsLeft) return hugLeft;
    if (onLeftHalf && fitsRight) return hugRight;
  }
  // A mark with no margin either side is a mark as wide as the paper. Beside it
  // if the page allows, and only then back inside it, because at that point
  // every answer is on top of something.
  const after = blockRight + pad;
  if (pageWidth <= 0 || after + chipWidth <= pageWidth) return after;
  const before = blockLeft - chipWidth - pad;
  if (before >= 0) return before;
  return Math.max(blockLeft + pad, blockRight - chipWidth - pad);
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

/** Ids are per-footnote, so the same timestamp-with-a-guard shape does. */
export function freshNoteId(existing: readonly DocFootnoteNote[], now = Date.now()): string {
  const base = `nt-${now.toString(36)}`;
  if (!existing.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!existing.some((entry) => entry.id === candidate)) return candidate;
  }
}

/** Ids for in-panel underline / highlight slices. */
export function freshSubMarkId(existing: readonly DocFootnoteSubMark[], now = Date.now()): string {
  const base = `sm-${now.toString(36)}`;
  if (!existing.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!existing.some((entry) => entry.id === candidate)) return candidate;
  }
}

/**
 * A one-line label for a saved thread, from what the reader asked.
 *
 * First line only, and short: the list is meant to be scanned, and a row that
 * wraps to four lines is a row that pushes the next thread off the card.
 */
export function threadTitleFrom(text: string, maxChars = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "Thread";
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
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

/**
 * Marks the reader has just selected over.
 *
 * The question this answers is what should happen when a new selection lands on
 * words that are already annotated, and the honest answer is "it depends, so
 * say so rather than guess":
 *
 *   - **Exactly the same span** is not a new annotation. Nobody marks the same
 *     words twice on purpose; they are trying to get back to the note they
 *     already made, and {@link samePlace} already knows what "the same" means.
 *     That case opens the existing card instead of making a duplicate.
 *   - **Overlapping but different** is a real new mark — selecting a paragraph
 *     that happens to contain a marked phrase is a perfectly ordinary thing to
 *     do — but it is also exactly when a reader is most likely to be making a
 *     near-duplicate by accident. So the overlap is offered as a row in the
 *     sheet, and choosing it goes to the existing note.
 *
 * What is deliberately *not* done is merging or extending. The reader chose a
 * span; quietly widening it to swallow a mark they did not select would be a
 * different quote from the one they are looking at.
 */
export function overlappingFootnotes(
  footnotes: readonly DocFootnote[],
  anchor: DocAnchor,
): DocFootnote[] {
  return footnotes.filter((entry) => anchorsOverlap(entry.anchor, anchor));
}

/** Does `a` share any of `b`'s span? Same scope only — see `docAnchors`. */
export function anchorsOverlap(a: DocAnchor, b: DocAnchor): boolean {
  if (a.scope !== b.scope) return false;
  if (isTextAnchor(a) && isTextAnchor(b)) {
    // Touching end-to-start is adjacency, not overlap: a quote that begins
    // where another ends has nothing in common with it.
    return a.start < b.end && b.start < a.end;
  }
  if (isRegionAnchor(a) && isRegionAnchor(b)) {
    return (
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    );
  }
  // A region and a run of text are not comparable — a band drawn over a
  // paragraph is a picture of it, not a claim about its characters.
  return false;
}

/** The mark this selection *is*, if the reader has already made it. */
export function footnoteAtSamePlace(
  footnotes: readonly DocFootnote[],
  anchor: DocAnchor,
): DocFootnote | null {
  return footnotes.find((entry) => samePlace(entry.anchor, anchor)) ?? null;
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

function sanitizeUserLinks(value: unknown): DocFootnoteUserLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value.flatMap((entry): DocFootnoteUserLink[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<DocFootnoteUserLink>;
    if (typeof candidate.url !== "string" || !candidate.url.trim()) return [];
    const title =
      typeof candidate.title === "string" && candidate.title.trim()
        ? candidate.title.trim()
        : undefined;
    return [{ url: candidate.url.trim(), ...(title ? { title } : {}) }];
  });
  return links.length > 0 ? links : undefined;
}

/**
 * Note entries, migrating the single `userNotes` box entries replaced.
 *
 * Read-old-write-new, the same bargain the ink codec takes: a library written
 * before entries existed still opens, and what it held becomes the first
 * entry rather than being dropped on the floor.
 */
function sanitizeNotes(value: unknown, legacy: unknown, now: number): DocFootnoteNote[] | undefined {
  const entries: DocFootnoteNote[] = Array.isArray(value)
    ? value.flatMap((entry): DocFootnoteNote[] => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Partial<DocFootnoteNote>;
        if (typeof candidate.id !== "string" || !candidate.id) return [];
        if (typeof candidate.text !== "string") return [];
        const createdAt = typeof candidate.createdAt === "number" ? candidate.createdAt : now;
        return [
          {
            id: candidate.id,
            text: candidate.text,
            createdAt,
            updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : createdAt,
          },
        ];
      })
    : [];
  if (entries.length === 0 && typeof legacy === "string" && legacy.trim()) {
    entries.push({ id: "nt-legacy", text: legacy, createdAt: now, updatedAt: now });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Saved threads, promoting a lone `threadRootId` from before the list existed. */
function sanitizeThreads(
  value: unknown,
  legacyRootId: unknown,
  excerpt: string,
  now: number,
): DocFootnoteThread[] | undefined {
  const entries: DocFootnoteThread[] = Array.isArray(value)
    ? value.flatMap((entry): DocFootnoteThread[] => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Partial<DocFootnoteThread>;
        if (typeof candidate.rootId !== "string" || !candidate.rootId) return [];
        return [
          {
            rootId: candidate.rootId,
            title: typeof candidate.title === "string" && candidate.title ? candidate.title : "Thread",
            createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
          },
        ];
      })
    : [];
  if (typeof legacyRootId === "string" && legacyRootId) {
    if (!entries.some((entry) => entry.rootId === legacyRootId)) {
      entries.unshift({
        rootId: legacyRootId,
        title: threadTitleFrom(excerpt),
        createdAt: now,
      });
    }
  }
  return entries.length > 0 ? entries : undefined;
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
      const now = Date.now();
      // `userNotes` was the single note box; it is read here and never written
      // again, so the property is stripped from the spread rather than carried.
      const {
        userNotes,
        title: rawTitle,
        palette: rawPalette,
        color: rawColor,
        updatedAt: rawUpdatedAt,
        ...rest
      } = candidate as DocFootnote & { userNotes?: unknown };
      // Pulled out of the spread so a stored non-number is dropped rather than
      // passed through as a timestamp nothing can compare.
      const updatedAt =
        typeof rawUpdatedAt === "number" && Number.isFinite(rawUpdatedAt)
          ? rawUpdatedAt
          : undefined;
      const notes = sanitizeNotes(candidate.notes, userNotes, now);
      const excerpt = typeof candidate.excerpt === "string" ? candidate.excerpt : "";
      const threads = sanitizeThreads(candidate.threads, candidate.threadRootId, excerpt, now);
      const userLinks = sanitizeUserLinks(candidate.userLinks);
      // A colour that is not a colour is dropped rather than passed through to
      // an inline style, where anything at all would be accepted.
      const color = isHexColor(rawColor) ? rawColor.trim() : undefined;
      const palette = normalizePalette(rawPalette) ?? undefined;
      const title =
        typeof rawTitle === "string" && rawTitle.trim()
          ? rawTitle.replace(/\s+/g, " ").trim()
          : undefined;
      const bands = sanitizeBands(candidate.bands);
      const blockText =
        typeof candidate.blockText === "string" && candidate.blockText.trim()
          ? candidate.blockText
          : undefined;
      const subMarks = sanitizeSubMarks(candidate.subMarks);
      return [
        {
          ...(rest as DocFootnote),
          anchor,
          notes,
          threads,
          ...(userLinks ? { userLinks } : {}),
          ...(color ? { color } : {}),
          ...(palette ? { palette } : {}),
          ...(title ? { title } : {}),
          ...(bands ? { bands } : {}),
          ...(blockText ? { blockText } : {}),
          ...(subMarks ? { subMarks } : {}),
          ...(updatedAt != null ? { updatedAt } : {}),
        },
      ];
    })
    .sort(sortByPosition);
}

/** Accept finite local rects only; drop the field when empty/corrupt. */
function sanitizeBands(value: unknown): LocalRect[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: LocalRect[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Partial<LocalRect>;
    if (
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height)
    ) {
      continue;
    }
    if ((r.width as number) <= 0 || (r.height as number) <= 0) continue;
    out.push({
      left: r.left as number,
      top: r.top as number,
      width: r.width as number,
      height: r.height as number,
    });
  }
  return out.length > 0 ? out : undefined;
}

const SUB_MARK_KINDS: ReadonlySet<DocFootnoteSubMarkKind> = new Set([
  "underline",
  "highlight",
]);

function sanitizeSubMarks(value: unknown): DocFootnoteSubMark[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: DocFootnoteSubMark[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const mark = entry as Partial<DocFootnoteSubMark>;
    if (typeof mark.id !== "string" || !mark.id) continue;
    if (!SUB_MARK_KINDS.has(mark.kind as DocFootnoteSubMarkKind)) continue;
    if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) continue;
    const start = mark.start as number;
    const end = mark.end as number;
    if (end <= start || start < 0) continue;
    const excerpt = typeof mark.excerpt === "string" ? mark.excerpt : "";
    const anchor = normalizeAnchor(mark.anchor);
    const textAnchor = anchor && isTextAnchor(anchor) ? anchor : undefined;
    const color = isHexColor(mark.color) ? mark.color.trim() : undefined;
    const palette = normalizePalette(mark.palette) ?? undefined;
    out.push({
      id: mark.id,
      kind: mark.kind as DocFootnoteSubMarkKind,
      excerpt,
      start,
      end,
      ...(textAnchor ? { anchor: textAnchor } : {}),
      ...(color ? { color } : {}),
      ...(palette ? { palette } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Google Search URL for a quote — the query is the words, nothing added. */
export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Quick links for a footnote overview — built from the excerpt or search query.
 *
 * Google is one row in the list, not the card's only action: the writer can
 * open any suggestion or add their own.
 */
export function suggestedLinksFor(
  excerpt: string,
  footnote?: DocFootnote,
): { title: string; url: string }[] {
  const query = footnote?.query ?? searchQueryFor(footnote?.excerpt ?? excerpt);
  const text = (query || excerpt || footnote?.excerpt || "").trim();
  if (!text) return [];
  const firstWord = text.split(/\s+/).filter(Boolean)[0] ?? text;
  return [
    {
      title: "Wikipedia",
      url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(text)}`,
    },
    {
      title: "Wiktionary",
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(firstWord)}`,
    },
    {
      title: "DuckDuckGo",
      url: `https://duckduckgo.com/?q=${encodeURIComponent(text)}`,
    },
    {
      title: "Google",
      url: footnote?.url ?? googleSearchUrl(text),
    },
  ];
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

/**
 * A cheap signature of everything about a set of marks that is worth saving.
 *
 * The autosave decides whether to write by comparing the board's scene
 * fingerprint, which cannot see a footnote at all — so a note typed into a card,
 * a link saved on one, or a colour chosen for a ribbon looked exactly like
 * nothing having happened, and closing the document lost it. This is the other
 * half of that comparison.
 *
 * Every field the reader can edit is in it. `createdAt` and the anchor are not:
 * they cannot change without the id changing too.
 */
export function footnoteRevision(footnotes: readonly DocFootnote[]): string {
  return footnotes.map(footnoteFieldsRevision).join("\x1d");
}

/**
 * One mark's editable fields, as a string.
 *
 * Split out of {@link footnoteRevision} so "has this mark changed?" can be asked
 * of a single mark — which is what {@link stampFootnoteEdits} needs, and which
 * keeps one definition of what counts as an edit rather than two that drift.
 */
export function footnoteFieldsRevision(entry: DocFootnote): string {
  return (
      [
        entry.id,
        entry.kind,
        entry.color ?? "",
        (entry.palette ?? []).join(","),
        entry.title ?? "",
        (entry.notes ?? []).map((note) => `${note.id}:${note.updatedAt}:${note.text}`).join("\x1f"),
        entry.threadRootId ?? "",
        (entry.threads ?? []).map((thread) => `${thread.rootId}|${thread.title}`).join("\x1f"),
        (entry.userLinks ?? []).map((link) => `${link.title ?? ""}|${link.url}`).join("\x1f"),
        (entry.bands ?? [])
          .map((b) => `${b.left},${b.top},${b.width},${b.height}`)
          .join("\x1f"),
        entry.blockText ?? "",
        (entry.subMarks ?? [])
          .map((m) =>
            [
              m.id,
              m.kind,
              m.start,
              m.end,
              m.excerpt,
              m.anchor ? `${m.anchor.start}:${m.anchor.end}:${m.anchor.scope ?? ""}` : "",
            ].join(":"),
          )
          .join("\x1f"),
      ].join("\x1e")
  );
}

/**
 * Stamp `updatedAt` on whatever the reader just changed.
 *
 * Compared before-and-after rather than stamped where marks are edited, for two
 * reasons. There are sixteen such places — a colour, a title, a note, a link, a
 * band, a sub-mark — and one that forgot would be silently wrong in a way
 * nothing catches. And {@link footnoteRevision} already had to decide exactly
 * which fields a reader can change, so asking it keeps one answer to that
 * question instead of two.
 *
 * A mark that did not change keeps the timestamp it had, so this is safe on
 * every update. A mark with no `updatedAt` — everything written before the field
 * existed — is left alone until something actually edits it, because inventing a
 * modification time is worse than admitting there is not one.
 */
export function stampFootnoteEdits(
  before: readonly DocFootnote[],
  after: readonly DocFootnote[],
  now = Date.now(),
): DocFootnote[] {
  if (before === after) return after as DocFootnote[];
  const was = new Map(before.map((entry) => [entry.id, footnoteFieldsRevision(entry)]));
  return after.map((entry) => {
    const previous = was.get(entry.id);
    // Newly added: its creation time is its modification time too.
    if (previous === undefined) {
      return entry.updatedAt == null ? { ...entry, updatedAt: entry.createdAt } : entry;
    }
    if (previous === footnoteFieldsRevision(entry)) return entry;
    return { ...entry, updatedAt: now };
  });
}
