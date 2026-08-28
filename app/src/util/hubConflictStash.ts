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
import type { DocFootnote } from "./docFootnotes";

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
  /** This device's pages, frozen at stop time. */
  localInk?: InkPageDto[];
  /** Hub pages at stop time. Missing means the GET failed. */
  serverInk?: InkPageDto[];
}

/** Synthetic row id for the handwriting choice on the split. */
export const INK_ROW_ID = "__ink__";

export type HubInkChoice = "local" | "server" | "merged" | "none";

/** What the reader chose; the caller applies it to stores and the hub. */
export type HubConflictResolution =
  | { pick: "local"; ink?: HubInkChoice }
  | { pick: "server"; ink?: HubInkChoice }
  | {
      pick: "merged";
      /**
       * The footnote set after per-mark picks. Board/source/name stay with
       * the base pane — those are whole-pane until someone answers for them.
       */
      footnotes?: DocFootnote[];
      ink?: HubInkChoice;
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
 * there, ✓ on each side keeps that copy, and ✓ on both keeps two notes.
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

/**
 * Apply the picks to the footnote set.
 *
 * A ✓ keeps that copy. Same-id-different-body ✓'d on both sides yields two
 * notes. Pane flags are the default only when that mark has no explicit pick —
 * the split now passes an explicit pick for every settled row and false/false
 * panes so mix-and-match cannot inherit a whole-pane keep.
 *
 * Local order leads and server-only marks append, so a resolve that keeps
 * everything reads back as the local set plus what only the hub had.
 */
export function mergeFootnotes(
  localNotes: readonly DocFootnote[],
  serverNotes: readonly DocFootnote[],
  panes: { local: boolean; server: boolean },
  picks: Record<string, { local: boolean; server: boolean }> = {},
): DocFootnote[] {
  const out: DocFootnote[] = [];
  for (const row of footnoteDiffRows(localNotes, serverNotes)) {
    const pick = picks[row.id];
    const keepLocal = pick ? pick.local : panes.local;
    const keepServer = pick ? pick.server : panes.server;
    if (keepLocal && row.local) out.push(row.local);
    if (keepServer && row.server) out.push(row.server);
  }
  return out;
}
