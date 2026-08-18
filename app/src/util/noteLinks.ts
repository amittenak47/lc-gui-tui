/**
 * Explicit links between workspaces — the note graph.
 *
 * The distinction that matters here: **edges are stated, not inferred.**
 * `docs.db` already knows which chunks of which files are near each other in
 * embedding space, and that is a fine way to *suggest* a link. It is not a
 * link. A graph built from cosine similarity says what a model thinks; this
 * one says what the reader wrote down, and only the second is worth navigating
 * by. Suggestions may appear as chips (§7); committing one is a pointer-up.
 *
 * Five ways an edge gets made, and each records which it was, because "I typed
 * this in the note" and "the app lifted it off a footnote" are not the same
 * claim and should not draw the same line on the atlas.
 *
 * Lives in IndexedDB beside the pads rather than in `docs.db`: the graph has
 * to work on a tablet with no daemon, and `docs.db` is hash-keyed retrieval
 * about file *text*, where this is about annotation sets, notebooks and
 * problems.
 */

import { run, STORE_LINKS, withStore } from "./idb";

/** What a node is. `thread` is a coach conversation, not a `TabKind`. */
export type NodeType = "annotate" | "whiteboard" | "practice" | "web" | "thread";

export interface NodeRef {
  type: NodeType;
  /**
   * The id in that type's own namespace:
   *
   * - `annotate` / `web` — the sidecar library id, **never** the file hash.
   *   Two annotation sets on one PDF are two nodes; the hash names neither.
   * - `whiteboard` — the notebook id.
   * - `practice` — `` `${dataset}/${taskId}` ``, the pair `loadProblem` uses.
   * - `thread` — the coach `rootId`, with {@link parent} naming the pad it
   *   lives on, since a thread is not reachable on its own.
   *
   * An unresolved `[[Title]]` is `annotate` with an `unresolved:` prefix — a
   * node that says something is missing, rather than a note created behind the
   * reader's back.
   */
  id: string;
  /** Denormalised so the graph can draw without opening every store. */
  title?: string;
  /** For `thread` only: the pad the conversation belongs to. */
  parent?: { type: NodeType; id: string };
}

export type EdgeKind =
  /** Typed as `[[Title]]` in an owned note's source. */
  | "wiki"
  /** Chosen from the Workspace links picker while annotating. */
  | "picker"
  /** Lifted from a footnote's coach thread. */
  | "footnote-thread"
  /** Lifted from a footnote's saved URL. The target is the URL itself. */
  | "footnote-url"
  /** Drawn with the Link tool. */
  | "ink";

export interface Edge {
  id: string;
  from: NodeRef;
  to: NodeRef;
  kind: EdgeKind;
  createdAt: number;
}

const UNRESOLVED = "unresolved:";

/** A node standing in for a `[[Title]]` that names nothing yet. */
export function unresolvedNode(title: string): NodeRef {
  return { type: "annotate", id: `${UNRESOLVED}${slugify(title)}`, title };
}

export function isUnresolved(node: NodeRef): boolean {
  return node.type === "annotate" && node.id.startsWith(UNRESOLVED);
}

export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Two refs naming the same thing. Titles are decoration and do not count. */
export function sameNode(a: NodeRef, b: NodeRef): boolean {
  return a.type === b.type && a.id === b.id;
}

export function nodeKey(node: NodeRef): string {
  return `${node.type}:${node.id}`;
}

/**
 * A stable id for an edge, derived from what it connects.
 *
 * Derived rather than random so the same link made twice is the same row.
 * Footnote lifts run on every open of a pad and would otherwise stack a new
 * copy each time; a `[[Title]]` typed twice in one note is one edge.
 */
export function edgeId(from: NodeRef, to: NodeRef, kind: EdgeKind): string {
  return `${kind}|${nodeKey(from)}|${nodeKey(to)}`;
}

export function makeEdge(
  from: NodeRef,
  to: NodeRef,
  kind: EdgeKind,
  createdAt = Date.now(),
): Edge {
  return { id: edgeId(from, to, kind), from, to, kind, createdAt };
}

function isEdge(value: unknown): value is Edge {
  if (!value || typeof value !== "object") return false;
  const row = value as Edge;
  return (
    typeof row.id === "string" &&
    typeof row.kind === "string" &&
    Boolean(row.from?.type) &&
    typeof row.from?.id === "string" &&
    Boolean(row.to?.type) &&
    typeof row.to?.id === "string"
  );
}

export async function listEdges(): Promise<Edge[]> {
  const rows: Edge[] = [];
  try {
    await withStore(STORE_LINKS, "readonly", (store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isEdge(cursor.value)) rows.push(cursor.value);
        cursor.continue();
      };
    });
  } catch {
    return [];
  }
  return rows;
}

/**
 * Every edge touching this node, in either direction.
 *
 * Undirected on read even though edges are stored with a direction: a note
 * that links to a problem and a problem linked from a note are the same
 * adjacency, and a reader hopping the graph does not care which end was typed.
 */
export async function edgesFor(node: NodeRef): Promise<Edge[]> {
  const all = await listEdges();
  return all.filter((edge) => sameNode(edge.from, node) || sameNode(edge.to, node));
}

/** The nodes one hop away, deduplicated, with the edge that got there. */
export async function neighbours(node: NodeRef): Promise<Array<{ node: NodeRef; edge: Edge }>> {
  const seen = new Set<string>();
  const out: Array<{ node: NodeRef; edge: Edge }> = [];
  for (const edge of await edgesFor(node)) {
    const other = sameNode(edge.from, node) ? edge.to : edge.from;
    const key = nodeKey(other);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ node: other, edge });
  }
  return out;
}

export async function putEdge(edge: Edge): Promise<void> {
  try {
    await run(STORE_LINKS, "readwrite", (store) => store.put(edge, edge.id));
  } catch {
    /* private browsing / missing store — the graph is not worth failing a save over */
  }
}

export async function deleteEdge(id: string): Promise<void> {
  try {
    await run(STORE_LINKS, "readwrite", (store) => store.delete(id));
  } catch {
    /* ignore */
  }
}

/** Drop every edge that names this node, for a pad that has been deleted. */
export async function deleteEdgesFor(node: NodeRef): Promise<void> {
  for (const edge of await edgesFor(node)) await deleteEdge(edge.id);
}

/** The footnote fields a lift reads — structural subset of `DocFootnote`. */
export interface LiftableFootnote {
  id: string;
  threads?: ReadonlyArray<{ rootId: string; title: string }>;
  userLinks?: ReadonlyArray<{ title?: string; url: string }>;
}

/**
 * The edges a pad's footnotes already imply.
 *
 * A mark that opened a coach thread, or that had a URL saved on it, is already
 * a link the reader made — it just lived on the footnote instead of in the
 * graph. This reads them out; it does not create anything new.
 *
 * Pure so the lift can be tested without a store, and so the caller can decide
 * when to run it. Ids are derived from the endpoints ({@link edgeId}), so
 * running this on every open of a pad rewrites the same rows rather than
 * stacking a fresh copy each time.
 */
export function footnoteEdges(pad: NodeRef, footnotes: readonly LiftableFootnote[]): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  for (const footnote of footnotes) {
    for (const thread of footnote.threads ?? []) {
      if (!thread.rootId) continue;
      const to: NodeRef = {
        type: "thread",
        id: thread.rootId,
        title: thread.title,
        parent: { type: pad.type, id: pad.id },
      };
      const edge = makeEdge(pad, to, "footnote-thread");
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      out.push(edge);
    }
    for (const link of footnote.userLinks ?? []) {
      if (!link.url) continue;
      // The URL is the node: an external page has no library id to name it by.
      const edge = makeEdge(pad, { type: "web", id: link.url, title: link.title ?? link.url }, "footnote-url");
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      out.push(edge);
    }
  }
  return out;
}

/**
 * Replace one note's typed links with the set its source now names.
 *
 * Delete-then-insert rather than insert-only, because renaming a `[[Title]]`
 * removes a link as surely as deleting the line does — and an insert-only
 * parse would leave the old target attached forever, so a note's graph would
 * only ever grow.
 *
 * Scoped to `kind: "wiki"` from this node: a link the reader made with the
 * picker or the pen is not something the parser is entitled to remove.
 */
export async function replaceWikiEdges(from: NodeRef, targets: readonly NodeRef[]): Promise<void> {
  const existing = await edgesFor(from);
  const wanted = new Map<string, NodeRef>();
  for (const target of targets) {
    if (sameNode(target, from)) continue; // a note linking to itself is noise
    wanted.set(edgeId(from, target, "wiki"), target);
  }
  for (const edge of existing) {
    if (edge.kind !== "wiki" || !sameNode(edge.from, from)) continue;
    if (!wanted.has(edge.id)) await deleteEdge(edge.id);
  }
  const now = Date.now();
  for (const [id, target] of wanted) {
    if (existing.some((edge) => edge.id === id)) continue;
    await putEdge(makeEdge(from, target, "wiki", now));
  }
}
