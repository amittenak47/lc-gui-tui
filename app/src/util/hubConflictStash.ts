/**
 * A sync conflict, parked where any pane can see it.
 *
 * The walk stops before applying anything — no LWW overwrite, no queueing a
 * doomed PUT behind a 409. What both sides held at stop time goes into this
 * stash so the split view can render Local | Server without re-fetching and
 * without the hub copy drifting under the reader mid-choice. It is a stash,
 * not a fork of the pad library: nothing here writes IDB or touches the open
 * workspace until the reader resolves.
 */

import type { AnnotatePadDto, InkPageDto, WhiteboardPadDto } from "../api/client";
import {
  inkPageDiffRows,
  type FootnoteInkBoard,
  type InkPageDiffRow,
  type InkPageStamp,
} from "./inkSync";
import type {
  DocFootnote,
  DocFootnoteNote,
  DocFootnoteSubMark,
  DocFootnoteThread,
  DocFootnoteWhiteboard,
} from "./docFootnotes";
import { freshWhiteboardId } from "./docFootnotes";

export type HubPadKind = "annotate" | "whiteboard";

export interface HubPadConflict {
  kind: HubPadKind;
  id: string;
  /** Which stage parked: the pad-JSON push (E) or the ink sync (F). */
  stage: "pad" | "ink";
  /** One sentence on why the walk stopped — shown above the split. */
  detail: string;
  /** What this device had, frozen when the walk stopped. */
  local: AnnotatePadDto | WhiteboardPadDto | null;
  /** What the hub held when the walk stopped. */
  server: AnnotatePadDto | WhiteboardPadDto | null;
  /** Ink conflicts only: the page both sides drew on since `since`. */
  inkPageId?: number;
  /**
   * This device's pages, frozen at stop time.
   *
   * A *preview* list, for the split's ink row and its overlay. An ink stop
   * narrows it to the colliding page rather than gzipping the whole pad, so
   * nothing may read it as "every page this device has" — the resolve path
   * takes {@link hubInkPageIds} for that.
   */
  localInk?: InkPageDto[];
  /**
   * Every page id the hub holds for this pad, off the ping digest.
   *
   * Ids, not bytes, and free: they ride on the ping the walk already made.
   * Keep Local and Drop Both empty-PUT the hub pages this device is
   * discarding, and that set has to be the whole one however little of it the
   * preview downloaded.
   */
  hubInkPageIds?: number[];
  /**
   * Every page id this device holds for this pad. Also ids, also cheap.
   *
   * The split says how much handwriting each side has. Counting the preview
   * lists would now answer "one page" about a whole read-through, so the row
   * counts these instead and draws from the preview.
   */
  localInkPageIds?: number[];
  /**
   * This device's pages as stamps (id + clock). The split diffs these against
   * {@link hubInkStamps} so only pages that disagree become rows.
   */
  localInkStamps?: InkPageStamp[];
  /**
   * Hub pages as stamps, off the ping digest. Same clock as a silent ink
   * newest-wins would have used.
   */
  hubInkStamps?: InkPageStamp[];
  /**
   * Footnote scratch boards with handwriting, on either side.
   *
   * Their strokes used to travel inside the pad's JSON, so a pane choice
   * carried them along whether or not anyone meant it to. They are hub ink
   * keys of their own now (`{padId}/fn/{wbId}`), which means the ink row has
   * to name them or a Keep would resolve the pad and leave the boards
   * disagreeing. Ids only — nothing paints a scratch board in the split, so
   * there is nothing to preview.
   */
  footnoteInk?: FootnoteInkBoard[];
  /**
   * Hub pages at stop time.
   *
   * `null` means the GET failed — not the same as `[]`, which is a successful
   * read of a pad with no handwriting. Treating a failed download as empty
   * made Keep Server wipe every local page.
   */
  serverInk?: InkPageDto[] | null;
}

/** Synthetic row id prefix for handwriting choices on the split. */
export const INK_ROW_ID = "__ink__";

export function inkPageRowId(pageId: number): string {
  return `${INK_ROW_ID}:${pageId}`;
}

export function parseInkPageRowId(id: string): number | null {
  const prefix = `${INK_ROW_ID}:`;
  if (!id.startsWith(prefix) || id.startsWith(`${INK_ROW_ID}:fn:`)) return null;
  const rest = id.slice(prefix.length);
  if (!/^-?\d+$/.test(rest)) return null;
  return Number(rest);
}

export function footnoteInkPageRowId(wbId: string, pageId: number): string {
  return `${INK_ROW_ID}:fn:${wbId}:${pageId}`;
}

export function parseFootnoteInkPageRowId(
  id: string,
): { wbId: string; pageId: number } | null {
  const prefix = `${INK_ROW_ID}:fn:`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  const wbId = rest.slice(0, colon);
  const pageId = Number(rest.slice(colon + 1));
  if (!wbId || !Number.isInteger(pageId)) return null;
  return { wbId, pageId };
}

export function isInkRowId(id: string): boolean {
  return (
    id === INK_ROW_ID ||
    parseInkPageRowId(id) != null ||
    parseFootnoteInkPageRowId(id) != null
  );
}

export type HubInkChoice = "local" | "server" | "merged" | "none";

export type HubInkPageChoice = { pageId: number; choice: HubInkChoice };
export type HubFootnoteInkPageChoice = {
  wbId: string;
  pageId: number;
  choice: HubInkChoice;
};

function stampsFrom(
  stamps: readonly InkPageStamp[] | undefined,
  ids: readonly number[] | undefined,
  pages: readonly InkPageDto[] | null | undefined,
): InkPageStamp[] {
  if (stamps?.length) {
    const gzBy = new Map((pages ?? []).map((page) => [page.page_id, page.gz]));
    return stamps.map((stamp) =>
      stamp.gz != null || !gzBy.has(stamp.pageId)
        ? stamp
        : { ...stamp, gz: gzBy.get(stamp.pageId) },
    );
  }
  if (pages?.length) {
    return pages.map((page) => ({
      pageId: page.page_id,
      updatedAt: page.updated_at,
      gz: page.gz,
    }));
  }
  return (ids ?? []).map((pageId) => ({ pageId, updatedAt: 0 }));
}

/**
 * Pad handwriting pages that disagree.
 *
 * The walk already syncs per page. The merge window used to lump them into one
 * row; this is that row split so a textbook with one contested margin still
 * keeps the rest.
 */
export function padInkDiffRows(conflict: HubPadConflict): InkPageDiffRow[] {
  const local = stampsFrom(
    conflict.localInkStamps,
    conflict.localInkPageIds,
    conflict.localInk,
  );
  const hub = stampsFrom(
    conflict.hubInkStamps,
    conflict.hubInkPageIds,
    conflict.serverInk ?? undefined,
  );
  const rows = inkPageDiffRows(local, hub);
  const colliding = conflict.inkPageId;
  if (colliding == null || rows.some((row) => row.pageId === colliding)) return rows;
  const hasLocal =
    local.some((stamp) => stamp.pageId === colliding) ||
    (conflict.localInkPageIds?.includes(colliding) ?? false) ||
    (conflict.localInk?.some((page) => page.page_id === colliding) ?? false);
  const hasServer =
    hub.some((stamp) => stamp.pageId === colliding) ||
    (conflict.hubInkPageIds?.includes(colliding) ?? false) ||
    (conflict.serverInk?.some((page) => page.page_id === colliding) ?? false);
  rows.push({
    pageId: colliding,
    hasLocal: hasLocal || !hasServer,
    hasServer: hasServer || !hasLocal,
  });
  rows.sort((a, b) => a.pageId - b.pageId);
  return rows;
}

export type FootnoteInkDiffRow = InkPageDiffRow & { wbId: string };

/** Scratch-board pages that disagree, one row per board+page. */
export function footnoteInkDiffRows(conflict: HubPadConflict): FootnoteInkDiffRow[] {
  const out: FootnoteInkDiffRow[] = [];
  for (const board of conflict.footnoteInk ?? []) {
    const local =
      board.localPages ?? board.localPageIds.map((pageId) => ({ pageId, updatedAt: 0 }));
    const hub =
      board.hubPages ?? board.hubPageIds.map((pageId) => ({ pageId, updatedAt: 0 }));
    for (const row of inkPageDiffRows(local, hub)) {
      out.push({ wbId: board.wbId, ...row });
    }
  }
  return out;
}

export function inkChoiceFromPick(
  pick: { local?: boolean; server?: boolean } | undefined,
): HubInkChoice {
  const local = pick?.local === true;
  const server = pick?.server === true;
  if (local && server) return "merged";
  if (local) return "local";
  if (server) return "server";
  return "none";
}

/** What the reader chose; the caller applies it to stores and the hub. */
export type HubConflictResolution =
  | {
      pick: "local";
      ink?: HubInkChoice;
      inkPages?: HubInkPageChoice[];
      footnoteInkPages?: HubFootnoteInkPageChoice[];
    }
  | {
      pick: "server";
      ink?: HubInkChoice;
      inkPages?: HubInkPageChoice[];
      footnoteInkPages?: HubFootnoteInkPageChoice[];
    }
  | {
      pick: "merged";
      /**
       * The footnote set after per-mark picks. Board/source/name stay with
       * the base pane — those are whole-pane until someone answers for them.
       */
      footnotes?: DocFootnote[];
      ink?: HubInkChoice;
      inkPages?: HubInkPageChoice[];
      footnoteInkPages?: HubFootnoteInkPageChoice[];
      /**
       * Incoming (hub) whiteboard ids reminted while combining a same-id mark.
       * The resolver copies the hub blob under the new id before local KV
       * overwrite, so both boards survive.
       */
      boardRemints?: Record<string, string>;
    };

/** Ink follows the pane when the split did not say. Merged notes still merge ink. */
export function inkChoiceOf(resolution: HubConflictResolution): HubInkChoice {
  if (resolution.ink) return resolution.ink;
  if (resolution.pick === "merged") return "merged";
  return resolution.pick;
}

let current: HubPadConflict | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function stashHubConflict(conflict: HubPadConflict): void {
  current = conflict;
  notify();
}

export function hubConflict(): HubPadConflict | null {
  return current;
}

export function clearHubConflict(): void {
  if (current === null) return;
  current = null;
  notify();
}

export function subscribeHubConflict(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetHubConflictForTests(): void {
  current = null;
  listeners.clear();
}

/**
 * The footnotes of one annotate pad, lined up by mark id across both panes.
 *
 * A row exists for every id either side knows. `sameId` marks the ones to
 * highlight on both sides; `differs` is a same-id row whose bodies are not —
 * there, ✓ on each side keeps that copy, and ✓ on both combines them into one
 * mark (see {@link combineFootnotePair}).
 */
export interface FootnoteDiffRow {
  id: string;
  local: DocFootnote | null;
  server: DocFootnote | null;
  sameId: boolean;
  differs: boolean;
}

export function footnoteDiffRows(
  localNotes: readonly DocFootnote[],
  serverNotes: readonly DocFootnote[],
): FootnoteDiffRow[] {
  const localBy = new Map(localNotes.map((note) => [note.id, note]));
  const serverBy = new Map(serverNotes.map((note) => [note.id, note]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const note of localNotes) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    ids.push(note.id);
  }
  for (const note of serverNotes) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    ids.push(note.id);
  }
  return ids.map((id) => {
    const local = localBy.get(id) ?? null;
    const server = serverBy.get(id) ?? null;
    return {
      id,
      local,
      server,
      sameId: local !== null && server !== null,
      differs:
        local !== null && server !== null && JSON.stringify(local) !== JSON.stringify(server),
    };
  });
}

/**
 * Same-id marks whose bodies match — they are not a merge choice.
 *
 * {@link footnoteDiffRows} still lists them so {@link mergeFootnotes} can keep
 * them; the split hides them so the window is differences only.
 */
export function visibleFootnoteDiffRows(
  localNotes: readonly DocFootnote[],
  serverNotes: readonly DocFootnote[],
): FootnoteDiffRow[] {
  return footnoteDiffRows(localNotes, serverNotes).filter(
    (row) => !row.sameId || row.differs,
  );
}

/** Granular pieces of a same-id mark that can be kept independently. */
export type FootnotePartKind = "notes" | "chats" | "boards" | "underlines";

export type FootnoteSidePick = { local?: boolean; server?: boolean };

export interface FootnotePartDiff {
  id: string;
  noteId: string;
  kind: FootnotePartKind;
  itemId: string;
  label: string;
  hasLocal: boolean;
  hasServer: boolean;
}

export function footnotePartRowId(
  noteId: string,
  kind: FootnotePartKind,
  itemId: string,
): string {
  return `${noteId}::${kind}:${itemId}`;
}

export function parseFootnotePartRowId(
  id: string,
): { noteId: string; kind: FootnotePartKind; itemId: string } | null {
  const at = id.indexOf("::");
  if (at <= 0) return null;
  const noteId = id.slice(0, at);
  const rest = id.slice(at + 2);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const kind = rest.slice(0, colon);
  const itemId = rest.slice(colon + 1);
  if (
    kind !== "notes" &&
    kind !== "chats" &&
    kind !== "boards" &&
    kind !== "underlines"
  ) {
    return null;
  }
  if (!noteId || !itemId) return null;
  return { noteId, kind, itemId };
}

export function footnoteOwnsBoard(row: FootnoteDiffRow, wbId: string): boolean {
  return [...(row.local?.whiteboards ?? []), ...(row.server?.whiteboards ?? [])].some(
    (board) => board.id === wbId,
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function previewOf(text: string | undefined, fallback: string): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function threadList(note: DocFootnote | null): DocFootnoteThread[] {
  const threads = [...(note?.threads ?? [])];
  const root = note?.threadRootId;
  if (root && !threads.some((thread) => thread.rootId === root)) {
    threads.unshift({
      rootId: root,
      title: "Coach chat",
      createdAt: note?.createdAt ?? 0,
    });
  }
  return threads;
}

function collectPartDiffs<T>(
  noteId: string,
  kind: FootnotePartKind,
  localItems: readonly T[],
  serverItems: readonly T[],
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
): FootnotePartDiff[] {
  const localBy = new Map(localItems.map((item) => [keyOf(item), item]));
  const serverBy = new Map(serverItems.map((item) => [keyOf(item), item]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of [...localItems, ...serverItems]) {
    const id = keyOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const out: FootnotePartDiff[] = [];
  for (const itemId of ids) {
    const local = localBy.get(itemId);
    const server = serverBy.get(itemId);
    if (local != null && server != null && jsonEqual(local, server)) continue;
    out.push({
      id: footnotePartRowId(noteId, kind, itemId),
      noteId,
      kind,
      itemId,
      label: labelOf((local ?? server)!),
      hasLocal: local != null,
      hasServer: server != null,
    });
  }
  return out;
}

/**
 * Which pieces of a same-id mark disagree, each as its own keep/drop row.
 *
 * Pad JSON already unions notes, coach-thread handles, and board pointers when
 * you ✓ both copies of the mark. Underlines stay local, and the actual scratch
 * pixels live on `fnwb:` keys listed separately. This list is how the split
 * names those pieces so a reader can keep notes from A and a board from B.
 *
 * One-sided marks have no parts — keeping the mark keeps everything on it.
 * Agent *messages* ride on the pad's `agent` array, not the footnote; the
 * chat row is the thread handle the mark stores.
 */
export function footnotePartDiffs(
  local: DocFootnote | null,
  server: DocFootnote | null,
): FootnotePartDiff[] {
  if (!local || !server) return [];
  return [
    ...collectPartDiffs(
      local.id,
      "notes",
      local.notes ?? [],
      server.notes ?? [],
      (note: DocFootnoteNote) => note.id,
      (note) => previewOf(note.text, "Note"),
    ),
    ...collectPartDiffs(
      local.id,
      "chats",
      threadList(local),
      threadList(server),
      (thread) => thread.rootId,
      (thread) => previewOf(thread.title, "Coach chat"),
    ),
    ...collectPartDiffs(
      local.id,
      "boards",
      local.whiteboards ?? [],
      server.whiteboards ?? [],
      (board: DocFootnoteWhiteboard) => board.id,
      (board) => previewOf(board.title, "Scratch board"),
    ),
    ...collectPartDiffs(
      local.id,
      "underlines",
      local.subMarks ?? [],
      server.subMarks ?? [],
      (mark: DocFootnoteSubMark) => mark.id,
      (mark) => previewOf(mark.excerpt, mark.kind),
    ),
  ];
}

function partChoice(
  noteId: string,
  kind: FootnotePartKind,
  itemId: string,
  parent: { local: boolean; server: boolean },
  picks?: Record<string, FootnoteSidePick>,
): { local: boolean; server: boolean } {
  const own = picks?.[footnotePartRowId(noteId, kind, itemId)];
  return {
    local: own?.local ?? parent.local,
    server: own?.server ?? parent.server,
  };
}

function mergeKeyed<T>(
  localItems: readonly T[] | undefined,
  incomingItems: readonly T[] | undefined,
  keyOf: (item: T) => string,
  noteId: string,
  kind: FootnotePartKind,
  parent: { local: boolean; server: boolean },
  picks: Record<string, FootnoteSidePick> | undefined,
  onBoth: (local: T, incoming: T) => T,
): T[] | undefined {
  const localBy = new Map((localItems ?? []).map((item) => [keyOf(item), item]));
  const incomingBy = new Map((incomingItems ?? []).map((item) => [keyOf(item), item]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of [...(localItems ?? []), ...(incomingItems ?? [])]) {
    const id = keyOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const out: T[] = [];
  for (const itemId of ids) {
    const choice = partChoice(noteId, kind, itemId, parent, picks);
    const local = localBy.get(itemId);
    const incoming = incomingBy.get(itemId);
    if (choice.local && choice.server) {
      if (local && incoming) out.push(onBoth(local, incoming));
      else if (local) out.push(local);
      else if (incoming) out.push(incoming);
    } else if (choice.local && local) {
      out.push(local);
    } else if (choice.server && incoming) {
      out.push(incoming);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Whether this entry has a finished choice.
 *
 * ✓ on either side is enough (that copy wins). Dropping it takes ✕ on every
 * side that actually has a copy. Undecided is not a choice.
 */
export function entrySettled(
  hasLocal: boolean,
  hasServer: boolean,
  pick: { local?: boolean; server?: boolean } | undefined,
): boolean {
  if (pick?.local === true || pick?.server === true) return true;
  if (hasLocal && hasServer) return pick?.local === false && pick?.server === false;
  if (hasLocal) return pick?.local === false;
  if (hasServer) return pick?.server === false;
  return true;
}

/** Concat two optional lists and drop repeats, keeping the local one. */
function unionBy<T>(
  local: readonly T[] | undefined,
  incoming: readonly T[] | undefined,
  keyOf: (item: T) => string,
): T[] | undefined {
  if (!local?.length && !incoming?.length) return undefined;
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of [...(local ?? []), ...(incoming ?? [])]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Same pointer on both copies of one mark: remint the incoming id so both
 * blobs keep a `fnwb:` key. Notes/threads/links still collapse by id.
 */
function mergeWhiteboardsForParts(
  local: readonly DocFootnoteWhiteboard[] | undefined,
  incoming: readonly DocFootnoteWhiteboard[] | undefined,
  remints: Record<string, string>,
  noteId: string,
  parent: { local: boolean; server: boolean },
  picks: Record<string, FootnoteSidePick>,
): DocFootnoteWhiteboard[] | undefined {
  const localBy = new Map((local ?? []).map((board) => [board.id, board]));
  const incomingBy = new Map((incoming ?? []).map((board) => [board.id, board]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const board of [...(local ?? []), ...(incoming ?? [])]) {
    if (seen.has(board.id)) continue;
    seen.add(board.id);
    ids.push(board.id);
  }
  const out: DocFootnoteWhiteboard[] = [];
  const used = [...(local ?? []), ...(incoming ?? [])].map((row) => ({
    id: row.id,
    createdAt: 0,
    updatedAt: 0,
  }));
  for (const itemId of ids) {
    const choice = partChoice(noteId, "boards", itemId, parent, picks);
    const mine = localBy.get(itemId);
    const theirs = incomingBy.get(itemId);
    if (choice.local && mine) out.push(mine);
    if (choice.server && theirs) {
      if (choice.local && mine) {
        const fresh = freshWhiteboardId(used);
        remints[theirs.id] = fresh;
        used.push({ id: fresh, createdAt: 0, updatedAt: 0 });
        out.push({ ...theirs, id: fresh });
      } else {
        out.push(theirs);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Two copies of the same mark, kept as one.
 *
 * ✓ on both sides of a same-id row used to produce two footnotes: the same
 * quote, ribboned twice, on the same words. Two different marks that happen to
 * share a page are two marks and stay two — but these are one mark that two
 * devices both wrote on, and the thing the reader asked for is everything they
 * wrote, not a duplicate of where they wrote it.
 *
 * The shell is local's, deliberately, down to the title: whichever device you
 * are standing at is the one whose wording you recognise, and a merge that
 * renamed your mark to the other device's title would be a surprise nobody
 * asked for. What the other side *added* comes across — its notes, its boards,
 * its threads, its links.
 *
 * `png` is the exception among the shell fields, because a missing crop is not
 * a choice: a region mark with no picture cannot say what it points at, so the
 * incoming one is better than none.
 *
 * `subMarks` default to local's. They index into `blockText` by offset, and
 * two devices that both edited the quote have two different sets of offsets
 * into two different strings — concatenating them would paint underlines
 * across words nobody underlined. When the quote text matches, A+B unions
 * by id. Explicit part picks override either rule.
 */
export function combineFootnotePair(
  local: DocFootnote,
  incoming: DocFootnote,
  remints: Record<string, string> = {},
  picks: Record<string, FootnoteSidePick> = {},
  parent: { local: boolean; server: boolean } = { local: true, server: true },
): DocFootnote {
  const noteId = local.id;
  const shell = parent.local ? local : incoming;
  const quotesMatch =
    (local.blockText ?? local.excerpt) === (incoming.blockText ?? incoming.excerpt);
  const underlineParent =
    parent.local && parent.server && !quotesMatch
      ? { local: true, server: false }
      : parent;
  const combined: DocFootnote = {
    ...shell,
    png: (parent.local ? local.png : incoming.png) ?? (parent.local ? incoming.png : local.png),
    notes: mergeKeyed(
      local.notes,
      incoming.notes,
      (note) => note.id,
      noteId,
      "notes",
      parent,
      picks,
      (mine) => mine,
    ),
    whiteboards: mergeWhiteboardsForParts(
      local.whiteboards,
      incoming.whiteboards,
      remints,
      noteId,
      parent,
      picks,
    ),
    threads: mergeKeyed(
      local.threads,
      incoming.threads,
      (thread) => thread.rootId,
      noteId,
      "chats",
      parent,
      picks,
      (mine) => mine,
    ),
    userLinks: parent.local && parent.server
      ? unionBy(local.userLinks, incoming.userLinks, (link) => link.url)
      : parent.local
        ? local.userLinks
        : incoming.userLinks,
    subMarks: mergeKeyed(
      local.subMarks,
      incoming.subMarks,
      (mark) => mark.id,
      noteId,
      "underlines",
      underlineParent,
      picks,
      (mine) => mine,
    ),
  };
  /*
   * Last touched by either device. Absent on both stays absent — a mark that
   * never recorded an edit time does not gain one by being merged.
   */
  const touched = [local.updatedAt, incoming.updatedAt].filter(
    (at): at is number => typeof at === "number",
  );
  if (touched.length > 0) combined.updatedAt = Math.max(...touched);
  // Keep the shape a single-sided keep would have produced.
  if (combined.notes === undefined) delete combined.notes;
  if (combined.whiteboards === undefined) delete combined.whiteboards;
  if (combined.threads === undefined) delete combined.threads;
  if (combined.userLinks === undefined) delete combined.userLinks;
  if (combined.subMarks === undefined) delete combined.subMarks;
  if (combined.png === undefined) delete combined.png;
  return combined;
}

/**
 * Apply the picks to the footnote set.
 *
 * A ✓ keeps that copy. ✓ on both sides of the *same* mark combines the two
 * into one — see {@link combineFootnotePair}; ✓ on both sides of the split
 * where the ids differ keeps both marks, because those are two marks. Pane
 * flags are the default only when that mark has no explicit pick — the split
 * now passes an explicit pick for every settled row and false/false panes so
 * mix-and-match cannot inherit a whole-pane keep.
 *
 * Same-id marks whose bodies already match are not a choice. They stay, even
 * when the panes drop every difference — hiding them from the window must not
 * delete them.
 *
 * Local order leads and server-only marks append, so a resolve that keeps
 * everything reads back as the local set plus what only the hub had.
 */
export function mergeFootnotes(
  localNotes: readonly DocFootnote[],
  serverNotes: readonly DocFootnote[],
  panes: { local: boolean; server: boolean },
  picks: Record<string, FootnoteSidePick> = {},
  remints: Record<string, string> = {},
): DocFootnote[] {
  const out: DocFootnote[] = [];
  for (const row of footnoteDiffRows(localNotes, serverNotes)) {
    if (row.sameId && !row.differs && row.local) {
      out.push(row.local);
      continue;
    }
    const pick = picks[row.id];
    const keepLocal = pick ? pick.local === true : panes.local;
    const keepServer = pick ? pick.server === true : panes.server;
    if (row.local && row.server && (keepLocal || keepServer)) {
      out.push(
        combineFootnotePair(row.local, row.server, remints, picks, {
          local: keepLocal,
          server: keepServer,
        }),
      );
      continue;
    }
    if (keepLocal && row.local) out.push(row.local);
    if (keepServer && row.server) out.push(row.server);
  }
  return out;
}
