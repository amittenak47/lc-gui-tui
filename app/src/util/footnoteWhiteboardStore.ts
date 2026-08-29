/**
 * Footnote-owned scratch boards — pointers on the mark, scene in contentStore.
 *
 * Not the whiteboard library: these keys never count toward the 50-notebook
 * cap, never call `saveWhiteboardNotebook`, and die with the annotation set.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { deleteContent, deleteContentByPrefix, getContent, putContent } from "./contentStore";
import type { DocFootnote, DocFootnoteWhiteboard } from "./docFootnotes";
import { freshWhiteboardId } from "./docFootnotes";
import {
  copyInkPages,
  deleteInkPages,
  deleteInkPagesByPrefix,
  footnoteWhiteboardDocKey,
} from "./inkPageStore";

export interface FootnoteWhiteboardContent {
  board: BoardBlob;
  pageCount: number;
}

export function footnoteWhiteboardKey(docId: string, wbId: string): string {
  return `fnwb:${docId}:${wbId}`;
}

export function footnoteWhiteboardPrefix(docId: string): string {
  return `fnwb:${docId}:`;
}

function isContent(value: unknown): value is FootnoteWhiteboardContent {
  if (!value || typeof value !== "object") return false;
  const row = value as FootnoteWhiteboardContent;
  return Boolean(row.board && typeof row.board === "object");
}

export async function putFootnoteWhiteboard(
  docId: string,
  wbId: string,
  content: FootnoteWhiteboardContent,
): Promise<void> {
  await putContent(footnoteWhiteboardKey(docId, wbId), {
    board: content.board,
    pageCount: Math.max(1, Math.floor(content.pageCount) || 1),
  });
}

/** Annotate workspace listens so its pad clock notices a split-pane save. */
export const FNWB_SAVED_EVENT = "lc-fnwb-saved";

export function emitFootnoteWhiteboardSaved(docId: string, wbId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FNWB_SAVED_EVENT, { detail: { docId, wbId } }));
}

export async function getFootnoteWhiteboard(
  docId: string,
  wbId: string,
): Promise<FootnoteWhiteboardContent | null> {
  const row = await getContent<unknown>(footnoteWhiteboardKey(docId, wbId));
  if (!isContent(row)) return null;
  return row;
}

export async function deleteFootnoteWhiteboard(docId: string, wbId: string): Promise<void> {
  await deleteContent(footnoteWhiteboardKey(docId, wbId));
  await deleteInkPages(footnoteWhiteboardDocKey(docId, wbId));
}

/** Every board this annotation set owns, including orphans with no pointer. */
export async function sweepFootnoteWhiteboards(docId: string): Promise<void> {
  await deleteContentByPrefix(footnoteWhiteboardPrefix(docId));
  await deleteInkPagesByPrefix(footnoteWhiteboardPrefix(docId));
}

export function whiteboardIdsOn(footnotes: readonly DocFootnote[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of footnotes) {
    for (const board of entry.whiteboards ?? []) {
      if (seen.has(board.id)) continue;
      seen.add(board.id);
      ids.push(board.id);
    }
  }
  return ids;
}

/**
 * A board without its strokes.
 *
 * `inkC` is the whole of a scratch board's handwriting, encoded into the blob.
 * It has no business on the wire: the strokes ride `putInkPage` per page,
 * gzipped, under this board's own hub key — the same split the notebook
 * library and a document's own pages have always used. Left in, every annotate
 * PUT sent a reader's scratch handwriting twice, uncompressed, inside a body
 * the hub caps at 32 MB.
 *
 * Local blobs written before the split still carry it, which is why this
 * strips rather than assumes. Reading it back is a different question — see
 * `restoreInk`, which prefers shards and falls through to `inkC`.
 */
export function slimFootnoteBoard(
  content: FootnoteWhiteboardContent,
): FootnoteWhiteboardContent {
  const board = content.board as BoardBlob & { inkC?: unknown };
  if (board?.inkC === undefined) return content;
  const { inkC: _dropped, ...rest } = board;
  return { ...content, board: rest as BoardBlob };
}

export async function collectFootnoteBoards(
  docId: string,
  footnotes: readonly DocFootnote[],
  opts: { slim?: boolean } = {},
): Promise<Record<string, FootnoteWhiteboardContent>> {
  const out: Record<string, FootnoteWhiteboardContent> = {};
  for (const wbId of whiteboardIdsOn(footnotes)) {
    const row = await getFootnoteWhiteboard(docId, wbId);
    if (row) out[wbId] = opts.slim ? slimFootnoteBoard(row) : row;
  }
  return out;
}

/**
 * Apply a board from the hub without throwing away strokes only we have.
 *
 * The wire form is slim now — structure, no `inkC` — and the handwriting
 * arrives separately as ink pages. A device that still holds a pre-split blob
 * has its only copy of those strokes inside `inkC`, so overwriting with the
 * slim body would erase them between the pad landing and the ink landing, and
 * for good if the ink never came. Carrying the local strokes across costs one
 * field and is dropped by the next ordinary save.
 *
 * Shards win over both on open — see `restoreInk` — so this cannot resurrect
 * ink another device erased.
 */
function keepLocalInk(
  incoming: FootnoteWhiteboardContent,
  local: FootnoteWhiteboardContent | null,
): FootnoteWhiteboardContent {
  const board = incoming.board as BoardBlob & { inkC?: unknown };
  if (board?.inkC !== undefined) return incoming;
  const mine = local?.board as (BoardBlob & { inkC?: unknown }) | undefined;
  if (mine?.inkC === undefined) return incoming;
  return { ...incoming, board: { ...board, inkC: mine.inkC } as BoardBlob };
}

export async function applyFootnoteBoards(
  docId: string,
  boards: Record<string, FootnoteWhiteboardContent> | null | undefined,
): Promise<void> {
  if (!boards || typeof boards !== "object") return;
  for (const [wbId, content] of Object.entries(boards)) {
    if (!wbId || !isContent(content)) continue;
    const local = await getFootnoteWhiteboard(docId, wbId);
    await putFootnoteWhiteboard(docId, wbId, keepLocalInk(content, local));
  }
}

/**
 * Conflict merge: copy reminted hub boards, then write hub then local.
 *
 * Local overwrite used to clobber the hub blob at a shared id. Remints are
 * applied first so the incoming copy lives under a new `fnwb:` key.
 */
export async function applyConflictFootnoteBoards(
  docId: string,
  localBoards: Record<string, FootnoteWhiteboardContent> | null | undefined,
  serverBoards: Record<string, FootnoteWhiteboardContent> | null | undefined,
  remints: Record<string, string> = {},
): Promise<void> {
  for (const [from, to] of Object.entries(remints)) {
    if (!to || to === from) continue;
    const blob = serverBoards?.[from];
    if (blob && isContent(blob)) await putFootnoteWhiteboard(docId, to, blob);
  }
  await applyFootnoteBoards(docId, serverBoards);
  await applyFootnoteBoards(docId, localBoards);
}

/**
 * Same-id-different-body marks kept as two notes share pointer ids.
 *
 * Mint a fresh whiteboard id on the duplicate and copy the blob so the two
 * marks do not share one `fnwb:` key.
 */
export async function forkSharedWhiteboardPointers(
  docId: string,
  footnotes: DocFootnote[],
  duplicateSource?: Record<string, FootnoteWhiteboardContent>,
): Promise<DocFootnote[]> {
  const seen = new Set<string>();
  const next: DocFootnote[] = [];
  for (const entry of footnotes) {
    const list = entry.whiteboards;
    if (!list || list.length === 0) {
      next.push(entry);
      continue;
    }
    let changed = false;
    const whiteboards: DocFootnoteWhiteboard[] = [];
    for (const board of list) {
      if (!seen.has(board.id)) {
        seen.add(board.id);
        whiteboards.push(board);
        continue;
      }
      changed = true;
      const used = [...seen].map((id) => ({ id, createdAt: 0, updatedAt: 0 }));
      const fresh = freshWhiteboardId(used);
      seen.add(fresh);
      const blob = duplicateSource?.[board.id] ?? (await getFootnoteWhiteboard(docId, board.id));
      if (blob) await putFootnoteWhiteboard(docId, fresh, blob);
      // The strokes live in shards now, not in the blob, so copying the blob
      // alone would hand the forked board a blank page.
      await copyInkPages(
        footnoteWhiteboardDocKey(docId, board.id),
        footnoteWhiteboardDocKey(docId, fresh),
      );
      whiteboards.push({ ...board, id: fresh, updatedAt: Date.now() });
    }
    next.push(changed ? { ...entry, whiteboards } : entry);
  }
  return next;
}
