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
 * `scope` is for documents that are not one stream. A PDF page and an EPUB
 * chapter each render their own root, and an offset is only meaningful inside
 * one of them — so PDF/EPUB anchors carry which one, and markdown leaves it
 * unset because there is only ever the one.
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

/** The document's whole character stream, the thing offsets index into. */
export function textOf(root: Node): string {
  return textNodesOf(root)
    .map((node) => node.data)
    .join("");
}

/** Absolute offset of a `(node, offset)` boundary, or null if it is not inside. */
function offsetOfBoundary(root: Node, node: Node, offset: number): number | null {
  let seen = 0;
  for (const text of textNodesOf(root)) {
    if (text === node) return seen + Math.min(offset, text.data.length);
    seen += text.data.length;
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

/** Rebuild a live range from an anchor, or null when the text has moved on. */
export function rangeFromAnchor(root: Node, anchor: DocAnchor): Range | null {
  if (anchor.end <= anchor.start) return null;
  const doc = root.ownerDocument;
  if (!doc) return null;
  let seen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const text of textNodesOf(root)) {
    const length = text.data.length;
    if (!startNode && anchor.start < seen + length) {
      startNode = text;
      startOffset = anchor.start - seen;
    }
    if (anchor.end <= seen + length) {
      endNode = text;
      endOffset = anchor.end - seen;
      break;
    }
    seen += length;
  }
  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, Math.max(0, startOffset));
  range.setEnd(endNode, Math.max(0, endOffset));
  return range;
}

/** The quoted text an anchor names, empty when it no longer resolves. */
export function textForAnchor(root: Node, anchor: DocAnchor): string {
  return rangeFromAnchor(root, anchor)?.toString() ?? "";
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
