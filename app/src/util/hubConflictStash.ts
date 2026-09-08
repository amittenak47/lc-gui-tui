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
import type { DocFootnote, DocFootnoteWhiteboard } from "./docFootnotes";
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
function unionWhiteboards(
  local: readonly DocFootnoteWhiteboard[] | undefined,
  incoming: readonly DocFootnoteWhiteboard[] | undefined,
  remints: Record<string, string>,
): DocFootnoteWhiteboard[] | undefined {
  if (!local?.length && !incoming?.length) return undefined;
  const out: DocFootnoteWhiteboard[] = [...(local ?? [])];
  const seen = new Set(out.map((board) => board.id));
  for (const board of incoming ?? []) {
    if (!seen.has(board.id)) {
      seen.add(board.id);
      out.push(board);
      continue;
    }
    const used = out.map((row) => ({ id: row.id, createdAt: 0, updatedAt: 0 }));
    const fresh = freshWhiteboardId(used);
    remints[board.id] = fresh;
    seen.add(fresh);
    out.push({ ...board, id: fresh });
  }
  return out;
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
 * `subMarks` are not merged. They are underlines indexing into `blockText` by
 * offset, and two devices that both edited the quote have two different sets of
 * offsets into two different strings — combining them by concatenation would
 * paint underlines across words nobody underlined. Local's stand.
 */
export function combineFootnotePair(
  local: DocFootnote,
  incoming: DocFootnote,
  remints: Record<string, string> = {},
): DocFootnote {
  const combined: DocFootnote = {
    ...local,
    png: local.png ?? incoming.png,
    notes: unionBy(local.notes, incoming.notes, (note) => note.id),
    whiteboards: unionWhiteboards(local.whiteboards, incoming.whiteboards, remints),
    threads: unionBy(local.threads, incoming.threads, (thread) => thread.rootId),
    userLinks: unionBy(local.userLinks, incoming.userLinks, (link) => link.url),
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
  picks: Record<string, { local: boolean; server: boolean }> = {},
  remints: Record<string, string> = {},
): DocFootnote[] {
  const out: DocFootnote[] = [];
  for (const row of footnoteDiffRows(localNotes, serverNotes)) {
    if (row.sameId && !row.differs && row.local) {
      out.push(row.local);
      continue;
    }
    const pick = picks[row.id];
    const keepLocal = pick ? pick.local : panes.local;
    const keepServer = pick ? pick.server : panes.server;
    if (keepLocal && keepServer && row.local && row.server) {
      out.push(combineFootnotePair(row.local, row.server, remints));
      continue;
    }
    if (keepLocal && row.local) out.push(row.local);
    if (keepServer && row.server) out.push(row.server);
  }
  return out;
}
