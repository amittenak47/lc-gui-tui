/**
 * Where a quote lives in a document, in a form that survives being closed.
 *
 * A footnote has to come back to the same words days later, so the anchor
 * cannot be a DOM node — those are rebuilt on every open — and it cannot be a
 * CSS path either, because a markdown re-render moves nodes around for reasons
 * that have nothing to do with the text. What does not move is the text: for a
 * given document the concatenated character stream is fixed, so a `[start,end)`
 * offset into it names the same words in any rendering of it.
 *
 * Offsets are **local to a scope** — a PDF page, an EPUB chapter — not to the
 * whole book. A renderer marks its sub-documents with `data-doc-scope` and each
 * becomes its own offset space. That costs a little (a quote cannot span a page
 * break) and buys three things a 1500-page textbook needs: resolving an anchor
 * walks one page's text instead of the whole book's, the marks near the reader
 * can be found without touching the rest, and every note carries the page it
 * belongs to — which is what lets the coach be told about *this* chapter rather
 * than about everything ever highlighted. A document with no scope roots
 * (markdown, a source file) is one unnamed scope, exactly as before.
 *
 * Not every mark is text. A highlighter sweep, a figure, a scanned page with no
 * text layer at all: those anchor as a **region** — a rectangle in the scope's
 * own coordinate space. It cannot follow reflowing text the way an offset can,
 * which is the same trade the pen ink already makes, and in exchange it works
 * on documents where there is nothing to select.
 *
 * The excerpt stored alongside is not used to find the range. It is what gets
 * shown when the range cannot be found at all — a document edited between
 * sessions should say "this is what you quoted" rather than lose the note.
 */

/** Attribute a renderer puts on each page / chapter to name an offset space. */
export const SCOPE_ATTR = "data-doc-scope";

export interface TextAnchor {
  kind: "text";
  /** Character offset into the scope's text where the quote starts. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Sub-document these offsets belong to — PDF page, EPUB spine href. */
  scope?: string;
}

/**
 * A rectangle in the scope's own layout coordinates.
 *
 * Unscaled CSS pixels relative to the scope root's top-left, so it survives the
 * board camera (which scales the whole subtree) but not a reflow of the page it
 * sits on. Reflow is why the pad pins a document's frame width once anything
 * has been drawn on it.
 */
export interface RegionAnchor {
  kind: "region";
  x: number;
  y: number;
  w: number;
  h: number;
  scope?: string;
}

export type DocAnchor = TextAnchor | RegionAnchor;

export function isTextAnchor(anchor: DocAnchor): anchor is TextAnchor {
  return anchor.kind === "text";
}

export function isRegionAnchor(anchor: DocAnchor): anchor is RegionAnchor {
  return anchor.kind === "region";
}

/**
 * Read an anchor that may predate the union.
 *
 * Everything stored before regions existed was a text anchor with no `kind`.
 * Normalising on the way in means the rest of the code can assume the tag, and
 * an old library entry keeps working rather than being quietly dropped.
 */
export function normalizeAnchor(value: unknown): DocAnchor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    kind?: unknown;
    start?: unknown;
    end?: unknown;
    x?: unknown;
    y?: unknown;
    w?: unknown;
    h?: unknown;
    scope?: unknown;
  };
  const scope = typeof raw.scope === "string" ? raw.scope : undefined;
  if (raw.kind === "region") {
    if (
      typeof raw.x !== "number" ||
      typeof raw.y !== "number" ||
      typeof raw.w !== "number" ||
      typeof raw.h !== "number"
    ) {
      return null;
    }
    if (raw.w <= 0 || raw.h <= 0) return null;
    return {
      kind: "region",
      x: raw.x,
      y: raw.y,
      w: raw.w,
      h: raw.h,
      ...(scope ? { scope } : {}),
    };
  }
  if (typeof raw.start !== "number" || typeof raw.end !== "number") return null;
  if (raw.end <= raw.start) return null;
  return {
    kind: "text",
    start: raw.start,
    end: raw.end,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Quote a scope for use inside an attribute selector.
 *
 * Not `CSS.escape`: an EPUB spine href is a path, which needs quoting rather
 * than identifier-escaping, and `CSS.escape` is missing from older WebViews and
 * from jsdom. Backslash and double quote are the only characters that can end
 * the quoted string, so they are the only ones that need handling.
 */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The element an anchor's offsets are measured against.
 *
 * The scope root when the document names one and the anchor belongs to it;
 * otherwise the body itself. Returning the body for an unknown scope is
 * deliberate: a footnote whose page has not rendered yet should fail to place
 * quietly and be picked up when it does, not throw.
 */
export function scopeRootIn(body: Element, scope?: string): Element | null {
  if (!scope) {
    // A document that names scopes but an anchor that does not is from before
    // scoping, or from a single-stream renderer — the body is its space.
    return body;
  }
  return body.querySelector(`[${SCOPE_ATTR}="${escapeAttr(scope)}"]`);
}

/** Every scope root a rendered document declares, in document order. */
export function scopeRootsIn(body: Element): HTMLElement[] {
  return Array.from(body.querySelectorAll<HTMLElement>(`[${SCOPE_ATTR}]`));
}

/** The scope a node sits in, or undefined in an unscoped document. */
export function scopeOfNode(body: Element, node: Node): string | undefined {
  const start = node instanceof Element ? node : node.parentElement;
  const host = start?.closest(`[${SCOPE_ATTR}]`);
  if (!host || !body.contains(host)) return undefined;
  return host.getAttribute(SCOPE_ATTR) ?? undefined;
}

/** Text nodes of a rendered document, in reading order. */
export function textNodesOf(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/**
 * Elements that end a run of prose.
 *
 * By tag rather than by computed style: this runs on every text node of a
 * whole book, and `getComputedStyle` per node is a layout read per node. The
 * list is the block-level set an annotated document actually contains — the
 * exotic cases it misses cost a missing space, not a broken anchor.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DIV",
  "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** Nearest block-level ancestor within the document, or the root itself. */
function blockOf(root: Node, node: Node): Node {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
  }
  return root;
}

/**
 * The document's character stream, with block boundaries spelled out.
 *
 * Concatenating text nodes raw is what the DOM gives you and it is not what a
 * reader sees: `<h1>Collisions</h1><p>Hash maps…` comes back as
 * "CollisionsHash maps…", and a quote taken across that seam reads as one
 * fused sentence — which is then what the coach is asked about, and what a
 * search box is handed. So a newline goes in wherever the prose changes block,
 * and it is part of the offset space rather than a display-time fix: a footnote
 * stored last week has to land on the same characters this week, and two
 * different notions of "offset" is how that stops being true.
 *
 * The separators are a function of the document's structure, which for a given
 * document does not change — so an anchor written before this existed is the
 * one thing it would move, and that is why it is worth doing once, here, rather
 * than per renderer.
 */
interface DocStream {
  text: string;
  /** Real text nodes, in reading order. */
  nodes: Text[];
  /** Absolute start offset of each node's data in `text`. */
  starts: number[];
}

function streamOf(root: Node): DocStream {
  const nodes = textNodesOf(root);
  const starts: number[] = [];
  let text = "";
  let previousBlock: Node | null = null;
  for (const node of nodes) {
    const block = blockOf(root, node);
    if (previousBlock !== null && block !== previousBlock) text += "\n";
    previousBlock = block;
    starts.push(text.length);
    text += node.data;
  }
  return { text, nodes, starts };
}

/** The document's whole character stream, the thing offsets index into. */
export function textOf(root: Node): string {
  return streamOf(root).text;
}

/** Absolute offset of a `(node, offset)` boundary, or null if it is not inside. */
function offsetOfBoundary(root: Node, node: Node, offset: number): number | null {
  const { nodes, starts } = streamOf(root);
  for (let i = 0; i < nodes.length; i += 1) {
    const text = nodes[i];
    if (text === node) return starts[i] + Math.min(offset, text.data.length);
  }
  // An element boundary (`<p>|<span>`) has no text node of its own. Fall back to
  // the first text node at or after it, which is where a caret there would land.
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
    if (child) {
      const nested = offsetOfBoundary(root, child, 0);
      if (nested != null) return nested;
    }
  }
  return null;
}

export function anchorFromRange(
  root: Node,
  range: Range,
  scope?: string,
): TextAnchor | null {
  const start = offsetOfBoundary(root, range.startContainer, range.startOffset);
  const end = offsetOfBoundary(root, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  return { kind: "text", start, end, ...(scope ? { scope } : {}) };
}

/**
 * A region anchor from a rectangle in viewport space.
 *
 * The board scales the whole document subtree, so a viewport rectangle is in
 * scaled pixels; dividing by the scope root's own scale puts it back into the
 * layout coordinates the anchor stores. Same conversion the highlight rects
 * use, for the same reason — see `localRects` in `DocSelectionLayer`.
 */
export function regionAnchorFromRect(
  scopeRoot: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
  scope?: string,
): RegionAnchor | null {
  const origin = scopeRoot.getBoundingClientRect();
  const layoutWidth = scopeRoot.offsetWidth;
  const scale = layoutWidth > 0 && origin.width > 0 ? origin.width / layoutWidth : 1;
  const w = rect.width / scale;
  const h = rect.height / scale;
  if (w <= 0 || h <= 0) return null;
  return {
    kind: "region",
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    w,
    h,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Rebuild a live range from an anchor, or null when the text has moved on.
 *
 * An offset can land on one of the synthetic block separators — a quote that
 * starts at a paragraph break, say. There is no node there to point at, so the
 * boundary rolls to the nearest real character in the direction that keeps the
 * quote whole: a start rolls forward into the next node, an end rolls back to
 * the close of the previous one.
 */
export function rangeFromAnchor(root: Node, anchor: DocAnchor): Range | null {
  if (!isTextAnchor(anchor)) return null;
  if (anchor.end <= anchor.start) return null;
  const doc = root.ownerDocument;
  if (!doc) return null;
  const { nodes, starts } = streamOf(root);
  if (nodes.length === 0) return null;

  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const from = starts[i];
    const to = from + node.data.length;
    if (!startNode && anchor.start < to) {
      startNode = node;
      startOffset = Math.max(0, anchor.start - from);
    }
    if (anchor.end <= to) {
      endNode = node;
      endOffset = Math.max(0, Math.min(anchor.end - from, node.data.length));
      break;
    }
    // Remember the last node the end could fall back to if it turns out to sit
    // on a separator past this point.
    endNode = node;
    endOffset = node.data.length;
  }
  if (!startNode || !endNode) return null;

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  // A start that rolled forward past the end (an anchor entirely inside a
  // separator) is not a quote.
  if (range.collapsed) return null;
  return range;
}

/**
 * The quoted text an anchor names, empty when it no longer resolves.
 *
 * Sliced out of the stream rather than taken from `Range.toString()`, which
 * concatenates the same way the DOM does and would hand back the fused
 * "CollisionsHash maps…" the separators exist to prevent.
 */
export function textForAnchor(root: Node, anchor: DocAnchor): string {
  if (!isTextAnchor(anchor)) return "";
  const { text } = streamOf(root);
  if (anchor.start >= text.length || anchor.end <= anchor.start) return "";
  return rangeFromAnchor(root, anchor)
    ? text.slice(anchor.start, Math.min(anchor.end, text.length))
    : "";
}

/** Characters that end a word for the purposes of snapping a selection out. */
const WORD_BREAK = /[\s ]/;

/**
 * Grow a selection to whole words.
 *
 * A finger is wider than a character, so a raw caret hit lands mid-word about
 * as often as not, and "Add to coach chat" with `ashmap collisi` in the quote
 * is worse than useless — it is a quote the coach will answer literally.
 * Snapping outward is the forgiving direction: the writer gets at least what
 * they touched.
 */
export function snapToWords(text: string, start: number, end: number): [number, number] {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));

  /*
   * A hit that landed in the gaps has to find a word first.
   *
   * The two loops below only ever grow *outward from a word*, so a caret that
   * landed on a space — between two words, in the indent, at the end of a
   * line — had nothing to grow from and the selection came back as the single
   * space that was touched. On a tablet that is not a rare case: a fingertip is
   * several characters wide and the gaps are a real fraction of a line.
   *
   * Searching forward first, then back, means a hold in the margin picks up the
   * word the reader was reaching towards rather than the one behind their
   * finger.
   */
  if (text.length === 0) return [0, 0];
  if (from === to || isAllBreaks(text, from, to)) {
    let word = from;
    while (word < text.length && WORD_BREAK.test(text[word])) word += 1;
    if (word >= text.length) {
      // Nothing ahead to reach for — take the word behind the finger instead.
      word = from;
      while (word > 0 && WORD_BREAK.test(text[word - 1])) word -= 1;
      if (word === 0) return [0, 0];
      // Land *inside* that word, not on the break after it, so the widening
      // below has a character to grow from.
      word -= 1;
    }
    from = word;
    // Reset the far end too. Keeping the caller's `to` here would drag the run
    // of whitespace that was actually touched into the quote.
    to = word + 1;
  }

  while (from > 0 && !WORD_BREAK.test(text[from - 1])) from -= 1;
  while (to < text.length && !WORD_BREAK.test(text[to])) to += 1;
  return [from, to];
}

function isAllBreaks(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (!WORD_BREAK.test(text[index])) return false;
  }
  return true;
}

/** One-line label for a quote — enough to recognise, short enough to sit under a bubble. */
export function excerptOf(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
