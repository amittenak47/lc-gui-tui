/**
 * `[[Wiki]]` links in an owned note's markdown.
 *
 * Parsed on save only, and only for notes the reader owns. Not on the rendered
 * page, not on an imported textbook, not on extracted PDF text, not on a web
 * capture — in all of those the brackets are somebody else's punctuation, and
 * treating them as links would invent edges from documents the reader never
 * wrote.
 *
 * Three forms, because the ambiguous one needs an escape hatch:
 *
 *   [[Some note]]              resolve by name against the library
 *   [[practice:two-sum]]       a problem, optionally `dataset/task`
 *   [[board:nb-123]]           a notebook, by id
 *
 * A `[[Title]]` that resolves to nothing stays unresolved rather than creating
 * a note. Auto-creating would mean a typo silently becomes a library entry.
 */

import { unresolvedNode, type NodeRef } from "./noteLinks";

/** One `[[…]]` found in the source, before it has been resolved. */
export interface WikiRef {
  /** Everything between the brackets, trimmed. */
  raw: string;
  /** `practice` / `board`, or null for a plain title. */
  scheme: "practice" | "board" | null;
  /** The part after the scheme, or the whole thing when there is none. */
  target: string;
}

/** Fenced code and inline code are text, not link syntax. */
function stripCode(source: string): string {
  // Replaced with same-length blanks so nothing downstream depends on offsets
  // that would shift if a fence were simply deleted.
  return source
    .replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

export function parseWikiRefs(source: string): WikiRef[] {
  const out: WikiRef[] = [];
  const seen = new Set<string>();
  for (const match of stripCode(source).matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const raw = match[1]!.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    // The same link typed twice in one note is one edge.
    if (seen.has(key)) continue;
    seen.add(key);
    const scheme = raw.startsWith("practice:")
      ? ("practice" as const)
      : raw.startsWith("board:")
        ? ("board" as const)
        : null;
    const target = scheme ? raw.slice(scheme.length + 1).trim() : raw;
    if (scheme && !target) continue;
    out.push({ raw, scheme, target });
  }
  return out;
}

/** What the resolver needs to know about the library, without importing it. */
export interface WikiIndex {
  /** Annotation sets: label first, then file name without its extension. */
  annotate: ReadonlyArray<{ id: string; name: string; label?: string }>;
  whiteboards: ReadonlyArray<{ id: string; title: string }>;
  /** The default dataset for a bare `practice:two-sum`. */
  defaultDataset: string;
}

function baseName(name: string): string {
  const cut = name.lastIndexOf(".");
  return cut > 0 ? name.slice(0, cut) : name;
}

/**
 * Turn one `[[…]]` into the node it names.
 *
 * Resolution order for a plain title is deliberate: a set's own label wins,
 * then its file name, then a notebook title. The label is the name the reader
 * chose, so it should beat the name a file happened to arrive with.
 */
export function resolveWikiRef(ref: WikiRef, index: WikiIndex): NodeRef {
  if (ref.scheme === "board") {
    const notebook = index.whiteboards.find((entry) => entry.id === ref.target);
    return { type: "whiteboard", id: ref.target, title: notebook?.title ?? ref.target };
  }
  if (ref.scheme === "practice") {
    const id = ref.target.includes("/") ? ref.target : `${index.defaultDataset}/${ref.target}`;
    return { type: "practice", id, title: id.split("/").pop() ?? id };
  }
  const wanted = ref.target.toLowerCase();
  const byLabel = index.annotate.find((entry) => entry.label?.trim().toLowerCase() === wanted);
  if (byLabel) return { type: "annotate", id: byLabel.id, title: byLabel.label ?? byLabel.name };
  const byName = index.annotate.find(
    (entry) =>
      entry.name.toLowerCase() === wanted || baseName(entry.name).toLowerCase() === wanted,
  );
  if (byName) return { type: "annotate", id: byName.id, title: byName.name };
  const board = index.whiteboards.find((entry) => entry.title.trim().toLowerCase() === wanted);
  if (board) return { type: "whiteboard", id: board.id, title: board.title };
  return unresolvedNode(ref.target);
}

/** Every node an owned note's source points at, deduplicated by node. */
export function resolveWikiLinks(source: string, index: WikiIndex): NodeRef[] {
  const out: NodeRef[] = [];
  const seen = new Set<string>();
  for (const ref of parseWikiRefs(source)) {
    const node = resolveWikiRef(ref, index);
    const key = `${node.type}:${node.id}`;
    // Two spellings can land on one node — `[[notes]]` and `[[notes.md]]`.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}
