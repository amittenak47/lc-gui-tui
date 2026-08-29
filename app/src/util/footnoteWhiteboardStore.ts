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

export async function collectFootnoteBoards(
  docId: string,
  footnotes: readonly DocFootnote[],
): Promise<Record<string, FootnoteWhiteboardContent>> {
  const out: Record<string, FootnoteWhiteboardContent> = {};
  for (const wbId of whiteboardIdsOn(footnotes)) {
    const row = await getFootnoteWhiteboard(docId, wbId);
    if (row) out[wbId] = row;
  }
  return out;
}

export async function applyFootnoteBoards(
  docId: string,
  boards: Record<string, FootnoteWhiteboardContent> | null | undefined,
): Promise<void> {
  if (!boards || typeof boards !== "object") return;
  for (const [wbId, content] of Object.entries(boards)) {
    if (!wbId || !isContent(content)) continue;
    await putFootnoteWhiteboard(docId, wbId, content);
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
      whiteboards.push({ ...board, id: fresh, updatedAt: Date.now() });
    }
    next.push(changed ? { ...entry, whiteboards } : entry);
  }
  return next;
}
