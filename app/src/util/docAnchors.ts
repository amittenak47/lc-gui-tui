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
 * All three document kinds render into a single root today — a PDF's pages and
 * an EPUB's chapters are laid end to end in one scrolling column — so one
 * offset space covers each of them and `scope` goes unused. It exists for the
 * day a renderer pages instead of scrolling, where an offset would only be
 * meaningful inside one page; an anchor that carries its scope keeps working
 * across that change, and one that does not would have to be re-derived.
 *
 * The excerpt stored alongside is not used to find the range. It is what gets
 * shown when the range cannot be found at all — a document edited between
 * sessions should say "this is what you quoted" rather than lose the note.
 */

export interface DocAnchor {
  /** Character offset into the document's text where the quote starts. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Sub-document this offset belongs to — PDF page, EPUB spine href. */
  scope?: string;
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
): DocAnchor | null {
  const start = offsetOfBoundary(root, range.startContainer, range.startOffset);
  const end = offsetOfBoundary(root, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  return { start, end, ...(scope ? { scope } : {}) };
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
  while (from > 0 && !WORD_BREAK.test(text[from - 1])) from -= 1;
  while (to < text.length && !WORD_BREAK.test(text[to])) to += 1;
  return [from, to];
}

/** One-line label for a quote — enough to recognise, short enough to sit under a bubble. */
export function excerptOf(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
