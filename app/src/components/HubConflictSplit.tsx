/**
 * The conflict split: Local on the left, the other device on the right.
 *
 * No choice has been saved yet. Each row (each handwriting page, each note)
 * is its own choice: ✓ that copy, ✓ both, or ✕ both (drop that entry). What
 * ✓ both means depends on what the row is: one mark two devices both wrote on
 * becomes one mark carrying both sides' notes and boards, ink merges that
 * page's strokes, and two marks that merely share a page stay two. Identical
 * footnotes and identical ink pages are omitted — they are not a choice. The
 * file itself always stays. Top ✓ keeps that column and discards the other
 * unless the other is already fully kept (A+B). Keep is enabled once every
 * row is settled, then PUT to the hub so the other device matches on Sync.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { AnnotatePadDto, InkPageDto, LcClient } from "../api/client";
import type { PageFrame } from "../canvas/inkPageIndex";
import { inkOpsBounds, type InkOp } from "../canvas/rasterInk";
import type { DocFootnote } from "../util/docFootnotes";
import { conflictFocusPage, inkDtosHavePage, mergeInkDtos } from "../util/conflictPage";
import { loadConflictPreviewInkPage, localInkAsDtos } from "../util/inkSync";
import { Tip } from "./Tip";
import { ConflictPagePreview } from "./ConflictPagePreview";
import { conflictDocumentWidth } from "./conflictDocumentLayout";
import { compareConflictInk } from "./conflictInkCompare";
import { inkOpsFrom } from "../canvas/inkCodec";
import {
  INK_ROW_ID,
  type FootnoteDiffRow,
  type FootnotePartDiff,
  type HubConflictResolution,
  type HubInkChoice,
  type HubPadConflict,
  entrySettled,
  footnoteInkDiffRows,
  footnoteInkPageRowId,
  footnoteOwnsBoard,
  footnotePartDiffs,
  inkChoiceFromPick,
  inkPageRowId,
  mergeFootnotes,
  padInkDiffRows,
  parseFootnoteInkPageRowId,
  parseFootnotePartRowId,
  parseInkPageRowId,
  footnoteDiffRows,
} from "../util/hubConflictStash";
import { linedPaperModeFromAppState, linedPitchStateFromAppState } from "../util/linedPaperPref";
import { mergeConflictPageFrames, decodeConflictInkPages, inkPageIdsFromOps, conflictPaperFrames, whiteboardConflictFrames, whiteboardInkMergeRows, pageFramesEqual } from "./conflictInkLayout";
import type { ConflictInkDecodeCache } from "./conflictInkLayout";
import {
  countWhiteboardPages,
  whiteboardPageFramesFromPad,
} from "../templates/whiteboard";

export interface HubConflictSplitProps {
  conflict: HubPadConflict | null;
  /** True while the resolve itself (IDB write + hub PUT) is running. */
  busy?: boolean;
  /** Right-pane name: Tablet when this device is the desktop, Desktop on the tablet. */
  otherLabel?: string;
  /** Open PDF content hash, so both panes can show the focused page. */
  docHash?: string;
  /** Live file bytes so each pane can borrow the same pdf.js document. */
  bytes?: ArrayBuffer;
  /** Unique film prefix per workspace — each pane appends -local / -server. */
  filmScopeBase?: string;
  /** Board scene width ink was drawn in. */
  sceneWidth?: number;
  /**
   * Where each page sits in the scene the ink was drawn in.
   *
   * Strokes carry absolute scene Y down the whole stack, so a pane needs the
   * frames to know where a page starts. Without them page 40's ink would be
   * drawn as though the book began at page 40.
   */
  pageFrames?: readonly PageFrame[];
  onResolve(resolution: HubConflictResolution): void;
  /** Why the last Keep selection did not leave this page. */
  error?: string | null;
  /** Hub client — used to GET one more ink page when a row is off the freeze preview. */
  client?: LcClient | null;
  /**
   * Test seam: one page of overlay ink. Production uses {@link loadConflictPreviewInkPage}.
   */
  fetchPreviewInk?: (pageId: number) => Promise<{
    local: InkPageDto | InkPageDto[] | null;
    server: InkPageDto | InkPageDto[] | null;
  }>;
}

type Side = "local" | "server";
type SidePick = { local?: boolean; server?: boolean };

function overlayInkPages(
  row: InkPageDto | InkPageDto[] | null | undefined,
): InkPageDto[] {
  if (row == null) return [];
  return Array.isArray(row) ? row : [row];
}

function updatedAtOf(pad: HubPadConflict["local"] | HubPadConflict["server"]): number | null {
  if (!pad) return null;
  const at = (pad as { updated_at?: unknown }).updated_at;
  return typeof at === "number" ? at : null;
}

function nameOf(conflict: HubPadConflict): string {
  const body = (conflict.local ?? conflict.server) as { name?: string; title?: string } | null;
  return body?.name ?? body?.title ?? "this pad";
}

function padBoardAppState(
  body: HubPadConflict["local"] | HubPadConflict["server"],
): unknown {
  if (!body || typeof body !== "object") return null;
  const board = (body as { board?: { appState?: unknown } }).board;
  if (!board || typeof board !== "object") return null;
  return (board as { appState?: unknown }).appState;
}

function padPageCount(conflict: HubPadConflict): number {
  const of = (body: unknown) => {
    const raw = (body as { page_count?: unknown } | null)?.page_count;
    return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  };
  const fromBoard = (body: unknown) => {
    const frames = whiteboardPageFramesFromPad(body);
    if (frames.length > 0) return frames.length;
    const board = (body as { board?: { elements?: unknown } } | null)?.board;
    const elements =
      board && typeof board === "object"
        ? (board as { elements?: unknown }).elements
        : undefined;
    return Array.isArray(elements) ? countWhiteboardPages(elements) : 0;
  };
  return Math.max(
    1,
    of(conflict.local),
    of(conflict.server),
    fromBoard(conflict.local),
    fromBoard(conflict.server),
  );
}

/**
 * How many pages of handwriting a side has.
 *
 * Older stashes carry no ids, so the preview list still stands in.
 */
function inkCount(
  ids: readonly number[] | null | undefined,
  pages: readonly InkPageDto[] | null | undefined,
): number {
  return ids?.length ?? pages?.length ?? 0;
}

function pickOf(
  picks: Record<string, SidePick>,
  id: string,
  side: Side,
): boolean | undefined {
  return picks[id]?.[side];
}

function inheritedPick(
  picks: Record<string, SidePick>,
  id: string,
  parentId: string,
  side: Side,
): boolean | undefined {
  const own = pickOf(picks, id, side);
  if (own !== undefined) return own;
  return pickOf(picks, parentId, side);
}

const PART_KIND_LABEL: Record<FootnotePartDiff["kind"], string> = {
  notes: "note",
  chats: "chat",
  boards: "board",
  underlines: "underline",
};

function NoteRow({
  id,
  kind,
  excerpt,
  side,
  sameId,
  differs,
  kept,
  dropped,
  focused,
  sideLabel,
  part,
  expanded,
  childCount,
  onKeep,
  onDrop,
  onFocus,
  onToggleExpand,
  missing = false,
  status,
}: {
  id: string;
  kind: string;
  excerpt: string;
  side: Side;
  sameId: boolean;
  differs: boolean;
  kept: boolean;
  dropped: boolean;
  focused: boolean;
  sideLabel: string;
  part?: boolean;
  expanded?: boolean;
  childCount?: number;
  onKeep(side: Side, id: string): void;
  onDrop(side: Side, id: string): void;
  onFocus(id: string): void;
  onToggleExpand?: () => void;
  missing?: boolean;
  status?: string;
}) {
  return (
    <li
      className={[
        "lc-hub-conflict-note",
        part ? "is-part" : "",
        sameId ? "is-same-id" : "",
        differs ? "is-differs" : "",
        focused ? "is-focused" : "",
        kept ? "is-keep" : "",
        dropped ? "is-drop" : "",
        missing ? "is-missing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-note-id={missing ? undefined : id}
      data-row-key={id}
      data-pick={kept ? "keep" : dropped ? "drop" : "undecided"}
      onClick={() => onFocus(id)}
    >
      {childCount != null && childCount > 0 && onToggleExpand ? (
        <button
          type="button"
          className="lc-hub-conflict-note-twist"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide changed pieces" : "Show changed pieces"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand();
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : null}
      <span className="lc-hub-conflict-note-kind">{kind}</span>
      <span className="lc-hub-conflict-note-excerpt">{missing ? "No entry on this device" : excerpt}</span>
      {!missing && <span className="lc-hub-conflict-note-flag">{status ?? (sameId ? "Different" : "Only here")}</span>}
      <span className="lc-hub-conflict-note-actions">
        <button
          type="button"
          data-action="keep"
          disabled={missing}
          aria-pressed={kept}
          aria-label={`Keep ${sideLabel} copy of ${part ? "piece" : "note"}`}
          title={
            kept
              ? "This copy is kept — tap to reconsider"
              : sameId
                ? `✓ keeps the ${sideLabel} copy. ✓ both combines them into one mark.`
                : `✓ keeps the ${sideLabel} copy`
          }
          className={kept ? "lc-doc-confirm-btn lc-doc-confirm-yes" : "lc-doc-confirm-btn"}
          onClick={(event) => {
            event.stopPropagation();
            onKeep(side, id);
            onFocus(id);
          }}
        >
          ✓
        </button>
        <button
          type="button"
          data-action="drop"
          disabled={missing}
          aria-pressed={dropped}
          aria-label={`Drop ${sideLabel} copy of ${part ? "piece" : "note"}`}
          title={
            dropped
              ? "This copy will be removed — tap to reconsider"
              : `✕ drops the ${sideLabel} copy. ✕ both sides removes this note.`
          }
          className={dropped ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"}
          onClick={(event) => {
            event.stopPropagation();
            onDrop(side, id);
            onFocus(id);
          }}
        >
          ✕
        </button>
      </span>
    </li>
  );
}

function notesOf(body: HubPadConflict["local"] | HubPadConflict["server"]): DocFootnote[] {
  return Array.isArray((body as AnnotatePadDto | null)?.footnotes)
    ? ((body as AnnotatePadDto).footnotes as DocFootnote[])
    : [];
}

export function HubConflictSplit({
  conflict,
  busy = false,
  otherLabel = "Tablet",
  docHash,
  bytes,
  filmScopeBase,
  sceneWidth,
  pageFrames,
  onResolve,
  error = null,
  client = null,
  fetchPreviewInk,
}: HubConflictSplitProps) {
  const [manualPicks, setManualPicks] = useState<Record<string, SidePick>>({});
  const [differencesOnly, setDifferencesOnly] = useState(true);
  const [revealInk, setRevealInk] = useState(false);
  const [inkComparisons, setInkComparisons] = useState<Record<number, boolean | null>>({});
  const listRefs = useRef<Partial<Record<Side, HTMLOListElement>>>({});
  const [focusedId, setFocusedId] = useState<string>(INK_ROW_ID);
  const [focusRevision, setFocusRevision] = useState(0);
  const focusRow = (id: string) => { setFocusedId(id); setFocusRevision(value => value + 1); };
  const [inkLoading, setInkLoading] = useState(false);
  const inkDecodeCache = useRef<ConflictInkDecodeCache>(new Map());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [overlayInk, setOverlayInk] = useState<{
    local: InkPageDto[];
    server: InkPageDto[];
  }>({ local: [], server: [] });
  const overlayInkRef = useRef(overlayInk);
  overlayInkRef.current = overlayInk;
  const overlayTriedRef = useRef<Set<number>>(new Set());
  const [inkHits, setInkHits] = useState<{
    local: number[];
    server: number[];
    maxY: number;
    localOps: InkOp[];
    serverOps: InkOp[];
    localShards: { pageId: number; ops: InkOp[] }[];
    serverShards: { pageId: number; ops: InkOp[] }[];
  }>({
    local: [],
    server: [],
    maxY: 0,
    localOps: [],
    serverOps: [],
    localShards: [],
    serverShards: [],
  });

  const sideLabel = (side: Side) => (side === "local" ? "Local" : otherLabel);

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    return footnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  // Workspace measures fresh arrays on each render. Equal frame values must
  // not cancel decoding and start the entire notebook again on a slow tablet.
  const pageFramesRef = useRef(pageFrames);
  if (!pageFramesEqual(pageFramesRef.current, pageFrames)) pageFramesRef.current = pageFrames;
  const stablePageFrames = pageFramesRef.current;
  const previewFrames = useMemo(
    () =>
      mergeConflictPageFrames(
        stablePageFrames,
        whiteboardPageFramesFromPad(conflict?.local ?? null),
        whiteboardPageFramesFromPad(conflict?.server ?? null),
      ),
    [stablePageFrames, conflict],
  );
  const listFrames = useMemo(
    () =>
      conflict?.kind === "whiteboard"
        ? whiteboardConflictFrames(previewFrames, padPageCount(conflict), inkHits.maxY)
        : conflictPaperFrames(
            previewFrames,
            Math.max(previewFrames.length, 1),
            inkHits.maxY,
          ),
    [previewFrames, conflict, inkHits.maxY],
  );
  const basePadInkRows = useMemo(
    () => (conflict?.wholeCanvas ? [{ pageId: 1, hasLocal: true, hasServer: true, same: false }] : conflict ? padInkDiffRows(conflict, true) : []),
    [conflict],
  );
  const padInkRows = useMemo(
    () =>
      conflict?.wholeCanvas ? basePadInkRows : conflict?.kind === "whiteboard"
        ? whiteboardInkMergeRows(
            basePadInkRows,
            listFrames,
            inkHits.localOps,
            inkHits.serverOps,
            true,
          )
        // Annotate resolves stored shards, including page 0 spanning ink.
        // Only whiteboards have a resolver for virtual sheet choices. Turning
        // PDF page 0/1 into virtual IDs asks the hub for pages it never stored.
        : basePadInkRows,
    [conflict, basePadInkRows, listFrames, inkHits],
  );
  const fnInkRows = useMemo(
    () => (conflict ? footnoteInkDiffRows(conflict, true) : []),
    [conflict],
  );

  const serverMissing = Boolean(conflict) && conflict!.server == null;
  const serverInkUnread = Boolean(conflict) && conflict!.serverInk === null;
  const partsByNote = useMemo(() => new Map(rows.map(row => [row.id,footnotePartDiffs(row.local,row.server,true)])),[rows]);

  const sameIds = new Set([
    ...rows.filter(row => row.sameId && !row.differs).map(row => row.id),
    ...[...partsByNote.values()].flat().filter(part => part.same).map(part => part.id),
    ...padInkRows.filter(row => !serverInkUnread && (row.same || inkComparisons[row.pageId] === true)).map(row => inkPageRowId(row.pageId)),
    ...fnInkRows.filter(row => row.same).map(row => footnoteInkPageRowId(row.wbId, row.pageId)),
  ]);
  const withAutomaticPicks = (manual: Record<string, SidePick>) => {
    const result = {...manual};
    for (const id of sameIds) result[id] = {local: manual[id]?.local ?? true, server: manual[id]?.server ?? true};
    return result;
  };
  const picks = withAutomaticPicks(manualPicks);
  const setPicks = (update: (current: Record<string, SidePick>) => Record<string, SidePick>) =>
    setManualPicks(current => update(withAutomaticPicks(current)));
  // A deliberate discard stays visible even when matching rows are hidden.
  const rowVisible = (id: string) => !differencesOnly || !sameIds.has(id) || picks[id]?.local === false || picks[id]?.server === false;
  const statusFor = (id: string, hasLocal: boolean, hasServer: boolean) => sameIds.has(id)
    ? "Same" : !hasLocal || !hasServer ? "Only here" : "Different";

  useEffect(() => {
    setManualPicks({});
    setInkComparisons({});
    setDifferencesOnly(true);
  }, [conflict]);

  useEffect(() => {
    // Compare one stored page at a time. Retain only the verdict, never a second
    // document's worth of decoded strokes or preview canvases.
    if (!conflict || conflict.kind !== "annotate" || conflict.wholeCanvas || serverInkUnread) return;
    let gone = false;
    // Unlike a visible preview, comparison needs only this shard, not the
    // potentially large spanning shard again for every page in the book.
    const load = fetchPreviewInk ?? (client ? async (pageId: number) => {
      const [local, server] = await Promise.all([
        localInkAsDtos(conflict.kind, conflict.id, [pageId]),
        client.getInkPage(conflict.kind, conflict.id, pageId),
      ]);
      return {local,server};
    } : null);
    const comparePage = async (pageId: number) => {
      let local = conflict.localInk?.find(row => row.page_id === pageId);
      let server = conflict.serverInk?.find(row => row.page_id === pageId);
      if ((!local || !server) && load) {
        const got = await load(pageId);
        local ??= overlayInkPages(got.local).find(row => row.page_id === pageId);
        server ??= overlayInkPages(got.server).find(row => row.page_id === pageId);
      }
      if (gone) return null;
      // A newer response isn't the frozen copy the user is comparing.
      const localStamp = conflict.localInkStamps?.find(row => row.pageId === pageId)?.updatedAt;
      const serverStamp = conflict.hubInkStamps?.find(row => row.pageId === pageId)?.updatedAt;
      if ((localStamp && local?.updated_at !== localStamp) || (serverStamp && server?.updated_at !== serverStamp)) return null;
      return compareConflictInk(local, server, inkDecodeCache.current);
    };
    void (async () => {
      // Let the visible preview register its decode promises first.
      await new Promise(resolve => window.setTimeout(resolve, 0));
      for (const row of basePadInkRows) {
        if (gone) return;
        if (row.same || !row.hasLocal || !row.hasServer) continue;
        const same = await comparePage(row.pageId).catch(() => null);
        if (gone) return;
        setInkComparisons(current => ({...current,[row.pageId]:same}));
        await new Promise(resolve => window.setTimeout(resolve, 16));
      }
    })();
    return () => { gone = true; };
  }, [conflict, basePadInkRows, client, fetchPreviewInk, serverInkUnread]);

  const padInkBlocked = (id: string): boolean => parseInkPageRowId(id) != null;

  const toggleKeep = (side: Side, id: string) => {
    if (side === "server" && serverMissing) return;
    if (side === "server" && padInkBlocked(id) && serverInkUnread) return;
    const other: Side = side === "local" ? "server" : "local";
    setPicks((current) => {
      const now = current[id]?.[side];
      if (now === true) {
        return { ...current, [id]: { ...current[id], [side]: undefined } };
      }
      const nextSide: SidePick = { ...current[id], [side]: true };
      if (nextSide[other] !== true) nextSide[other] = false;
      return { ...current, [id]: nextSide };
    });
  };

  const toggleDrop = (side: Side, id: string) => {
    setPicks((current) => {
      const now = current[id]?.[side];
      return { ...current, [id]: { ...current[id], [side]: now === false ? undefined : false } };
    });
  };

  const idsOnSide = (side: Side, visibleOnly = false): string[] => {
    const ids: string[] = [];
    for (const row of padInkRows) {
      const has = side === "local" ? row.hasLocal : row.hasServer;
      if (has) ids.push(inkPageRowId(row.pageId));
    }
    for (const row of fnInkRows) {
      const has = side === "local" ? row.hasLocal : row.hasServer;
      if (has) ids.push(footnoteInkPageRowId(row.wbId, row.pageId));
    }
    for (const row of rows) {
      const has = side === "local" ? Boolean(row.local) : Boolean(row.server);
      if (has) ids.push(row.id);
    }
    return visibleOnly ? ids.filter(rowVisible) : ids;
  };

  const paneFilled = (side: Side, value: boolean): boolean => {
    const ids = idsOnSide(side, true);
    if (ids.length === 0) return false;
    return ids.every((id) => pickOf(picks, id, side) === value);
  };

  const setSideAll = (side: Side, value: boolean | undefined) => {
    if (side === "server" && serverMissing && value === true) return;
    const ids = idsOnSide(side, true);
    setPicks((current) => {
      const next = { ...current };
      for (const id of ids) {
        if (side === "server" && padInkBlocked(id) && serverInkUnread && value === true) {
          continue;
        }
        next[id] = { ...next[id], [side]: value };
      }
      return next;
    });
  };

  const onPaneKeep = (side: Side) => {
    const other: Side = side === "local" ? "server" : "local";
    if (side === "server" && serverMissing) return;
    setPicks((current) => {
      const ids = idsOnSide(side, true);
      const otherIds = idsOnSide(other, true);
      if (ids.length === 0) return current;
      const thisFilled = ids.every((id) => current[id]?.[side] === true);
      const next = { ...current };
      if (thisFilled) {
        for (const id of ids) next[id] = { ...next[id], [side]: undefined };
        return next;
      }
      const otherFilled =
        otherIds.length > 0 && otherIds.every((id) => current[id]?.[other] === true);
      for (const id of ids) {
        if (side === "server" && padInkBlocked(id) && serverInkUnread) continue;
        next[id] = { ...next[id], [side]: true };
      }
      if (!otherFilled) {
        for (const id of otherIds) next[id] = { ...next[id], [other]: false };
      }
      return next;
    });
  };

  const onPaneDrop = (side: Side) => {
    setSideAll(side, paneFilled(side, false) ? undefined : false);
  };

  const paneVerdict = (side: Side): "undecided" | "keep" | "reject" => {
    if (paneFilled(side, true)) return "keep";
    if (paneFilled(side, false)) return "reject";
    return "undecided";
  };

  const inkPageChoices = () =>
    padInkRows.filter(row => {
      const id = inkPageRowId(row.pageId);
      return !sameIds.has(id) || !(picks[id]?.local || picks[id]?.server);
    }).map((row) => ({
      pageId: row.pageId,
      choice: inkChoiceFromPick(picks[inkPageRowId(row.pageId)]),
    }));

  const footnoteInkPageChoices = () =>
    fnInkRows.filter(row => {
      const id = footnoteInkPageRowId(row.wbId, row.pageId);
      return !sameIds.has(id) || !(picks[id]?.local || picks[id]?.server);
    }).map((row) => ({
      wbId: row.wbId,
      pageId: row.pageId,
      choice: inkChoiceFromPick(picks[footnoteInkPageRowId(row.wbId, row.pageId)]),
    }));

  const inkChoice = (): HubInkChoice => {
    const choices = [
      ...inkPageChoices().map((row) => row.choice),
      ...footnoteInkPageChoices().map((row) => row.choice),
    ];
    if (choices.length === 0) return "none";
    const first = choices[0]!;
    return choices.every((choice) => choice === first) ? first : "merged";
  };

  const notesHomed = rows.every((row) =>
    entrySettled(Boolean(row.local), Boolean(row.server), picks[row.id]),
  );
  const inkHomed =
    padInkRows.every((row) =>
      entrySettled(row.hasLocal, row.hasServer, picks[inkPageRowId(row.pageId)]),
    ) &&
    fnInkRows.every((row) =>
      entrySettled(
        row.hasLocal,
        row.hasServer,
        picks[footnoteInkPageRowId(row.wbId, row.pageId)],
      ),
    );
  const valid = Boolean(conflict) && notesHomed && inkHomed;
  const localInkPages = useMemo(
    () => (conflict ? mergeInkDtos(conflict.localInk, overlayInk.local) : []),
    [conflict, overlayInk.local],
  );
  const serverInkPages = useMemo(
    () => (conflict ? mergeInkDtos(conflict.serverInk, overlayInk.server) : []),
    [conflict, overlayInk.server],
  );

  useEffect(() => {
    if (!conflict) {
      setInkHits({
        local: [],
        server: [],
        maxY: 0,
        localOps: [],
        serverOps: [],
        localShards: [],
        serverShards: [],
      });
      return;
    }
    let gone = false;
    const controller = new AbortController();
    const retained = new Set([...localInkPages, ...serverInkPages].map(row => row.gz));
    for (const key of inkDecodeCache.current.keys()) {
      if (!retained.has(key)) inkDecodeCache.current.delete(key);
    }
    setInkLoading(true);
    void (async () => {
      const [localShards, serverShards] = await Promise.all([
        decodeConflictInkPages(localInkPages, inkDecodeCache.current, controller.signal),
        decodeConflictInkPages(serverInkPages, inkDecodeCache.current, controller.signal),
      ]);
      // Older annotation sets carry their full ink in the board JSON. Only
      // use that fallback when no page record exists (an empty shard is a deletion).
      for (const [body, pages, shards, ids] of [[conflict.local,localInkPages,localShards,conflict.localInkPageIds],[conflict.server,serverInkPages,serverShards,conflict.hubInkPageIds]] as const) {
        const board = body?.board;
        if (!pages.length && board && typeof board === "object") {
          const ops = inkOpsFrom(board);
          if (ops.length) shards.push({pageId:conflict.kind === "annotate" ? 0 : 1,ops});
        }
        const manifest = (board as {inkPages?:{pageIds?:number[]}} | null)?.inkPages?.pageIds;
        const declared = ids ?? manifest;
        if (conflict.kind === "annotate" && declared?.length && !declared.some(id => id > 1)) {
          for (const shard of shards) if (shard.pageId === 1) shard.pageId = 0;
        }
      }
      if (gone) return;
      const localOps = localShards.flatMap((shard) => shard.ops);
      const serverOps = serverShards.flatMap((shard) => shard.ops);
      const maxY = Math.max(
        inkOpsBounds(localOps)?.maxY ?? 0,
        inkOpsBounds(serverOps)?.maxY ?? 0,
      );
      const frames =
        conflict.kind === "whiteboard"
          ? whiteboardConflictFrames(previewFrames, padPageCount(conflict), maxY)
          : conflictPaperFrames(
              previewFrames,
              Math.max(previewFrames.length, 1),
              maxY,
            );
      setInkHits({
        local: inkPageIdsFromOps(localOps, frames),
        server: inkPageIdsFromOps(serverOps, frames),
        maxY,
        localOps,
        serverOps,
        localShards,
        serverShards,
      });
      setInkLoading(false);
    })();
    return () => {
      gone = true;
      controller.abort();
    };
  }, [conflict, previewFrames, localInkPages, serverInkPages]);
  const localChoiceIds = new Set(idsOnSide("local"));
  const serverChoiceIds = new Set(idsOnSide("server"));
  const choiceIds = [...new Set([...localChoiceIds, ...serverChoiceIds])];
  const remainingChoices = choiceIds.filter((id) => {
    const hasLocal = localChoiceIds.has(id);
    const hasServer = serverChoiceIds.has(id);
    return !entrySettled(hasLocal, hasServer, picks[id]);
  }).length;
  const pickingStarted = Object.values(picks).some(
    (pick) => pick.local !== undefined || pick.server !== undefined,
  );

  const allKept = (side: Side): boolean =>
    rows.every((row) => {
      const has = side === "local" ? row.local : row.server;
      if (!has) return true;
      return pickOf(picks, row.id, side) === true;
    });
  const noneKept = (side: Side): boolean =>
    rows.every((row) => {
      const has = side === "local" ? row.local : row.server;
      if (!has) return true;
      return pickOf(picks, row.id, side) !== true;
    });

  const overallPick = (): HubConflictResolution["pick"] => {
    if (conflict?.kind === "annotate" && Object.keys(manualPicks).some(id => parseFootnotePartRowId(id))) return "merged";
    const ink = inkChoice();
    if (conflict?.kind !== "annotate") {
      if (ink === "server") return "server";
      if (ink === "merged") return "merged";
      return "local";
    }
    if (allKept("local") && noneKept("server") && (ink === "local" || ink === "none")) {
      return "local";
    }
    if (
      !serverMissing &&
      allKept("server") &&
      noneKept("local") &&
      (ink === "server" || ink === "none")
    ) {
      return "server";
    }
    return "merged";
  };

  const onResolveTap = () => {
    if (!conflict || !valid) return;
    const ink = inkChoice();
    const pick = overallPick();
    const inkPages = inkPageChoices();
    const footnoteInkPages = footnoteInkPageChoices();
    if (pick !== "merged" || conflict.kind !== "annotate") {
      onResolve({ pick, ink, inkPages, footnoteInkPages });
      return;
    }
    const boardRemints: Record<string, string> = {};
    const merged = mergeFootnotes(
      notesOf(conflict.local),
      notesOf(conflict.server),
      { local: false, server: false },
      picks,
      boardRemints,
    );
    onResolve({
      pick: "merged",
      footnotes: merged,
      ink,
      inkPages,
      footnoteInkPages,
      ...(Object.keys(boardRemints).length > 0 ? { boardRemints } : {}),
    });
  };

  const focusPage = useMemo(() => {
    if (!conflict) return 1;
    const padPage = parseInkPageRowId(focusedId);
    if (padPage != null) {
      return padPage >= 1 ? padPage : conflictFocusPage({ inkPageId: conflict.inkPageId });
    }
    const fnPage = parseFootnoteInkPageRowId(focusedId);
    if (fnPage) {
      return fnPage.pageId >= 1 ? fnPage.pageId : 1;
    }
    if (focusedId === INK_ROW_ID) {
      return conflictFocusPage({
        inkPageId: conflict.inkPageId ?? padInkRows[0]?.pageId,
        ink: [...(conflict.localInk ?? []), ...(conflict.serverInk ?? [])],
      });
    }
    const part = parseFootnotePartRowId(focusedId);
    const noteFocus = part?.noteId ?? focusedId;
    const row = rows.find((row) => row.id === noteFocus);
    return conflictFocusPage({
      note: row?.local ?? row?.server,
      inkPageId: conflict.inkPageId,
      ink: conflict.localInk,
    });
  }, [conflict, focusedId, rows, padInkRows]);

  useEffect(() => {
    setOverlayInk(current => current.local.length || current.server.length
      ? { local: [], server: [] } : current);
    overlayTriedRef.current = new Set();
  }, [conflict?.id]);

  const previewPageKey = String(focusPage);
  useEffect(() => {
    if (!conflict || focusPage < 1) return;
    if (!fetchPreviewInk && !client) return;
    const localPages = mergeInkDtos(conflict.localInk, overlayInkRef.current.local);
    const serverPages = mergeInkDtos(conflict.serverInk, overlayInkRef.current.server);
    const lumpedWhiteboard =
      conflict.kind === "whiteboard" &&
      ![...(conflict.localInk ?? []), ...(conflict.serverInk ?? [])].some(
        (page) => page.page_id >= 2,
      );
    /*
     * Page 1 gz is the whole notebook blob, so it covers every virtual sheet.
     * Page 0 is the spanning shard — it does not stand in for page 1.
     */
    const covers = (pages: readonly InkPageDto[], pageId: number) =>
      inkDtosHavePage(pages, pageId) ||
      (lumpedWhiteboard &&
        pageId >= 1 &&
        pages.some((page) => page.page_id === 1 && Boolean(page.gz)));
    const wanted = previewPageKey.split(",").map(Number).filter(pageId =>
      pageId >= 1 && !overlayTriedRef.current.has(pageId) && !(covers(localPages, pageId) && covers(serverPages, pageId)));
    if (!wanted.length) return;
    let gone = false;
    const pending = new Set<number>();
    const load =
      fetchPreviewInk ??
      ((pageId: number) =>
        loadConflictPreviewInkPage(client, conflict.kind, conflict.id, pageId));
    void (async () => {
      for (const pageId of wanted) {
        if (gone) return;
        overlayTriedRef.current.add(pageId);
        pending.add(pageId);
        try {
          const got = await load(pageId);
          if (gone) return;
          pending.delete(pageId);
          if (got.server === null) overlayTriedRef.current.delete(pageId);
          setOverlayInk((current) => ({
            local: mergeInkDtos(current.local, overlayInkPages(got.local)).filter(row => row.page_id === 0 || previewPageKey.split(",").map(Number).includes(row.page_id)),
            server: mergeInkDtos(current.server, overlayInkPages(got.server)).filter(row => row.page_id === 0 || previewPageKey.split(",").map(Number).includes(row.page_id)),
          }));
        } catch {
          pending.delete(pageId);
          overlayTriedRef.current.delete(pageId);
        }
      }
    })();
    return () => {
      gone = true;
      for (const pageId of pending) overlayTriedRef.current.delete(pageId);
      // Evicted previews can be loaded again after the next row jump.
      for (const pageId of overlayTriedRef.current) if (!previewPageKey.split(",").map(Number).includes(pageId)) overlayTriedRef.current.delete(pageId);
    };
  }, [client, conflict, fetchPreviewInk, previewPageKey]);

  if (!conflict) return null;

  const whyDisabled = !conflict
    ? ""
    : serverMissing
      ? "The other copy could not be read, so only this device's copy can be kept. ✓ Local (or each of its changes)."
      : serverInkUnread && !valid
        ? "The other device's handwriting could not be read, so it cannot be kept. ✓ Local handwriting, or ✕ both."
      : !valid
        ? pickingStarted && remainingChoices > 0
          ? `${remainingChoices} ${
              remainingChoices === 1 ? "change still needs" : "changes still need"
            } a choice — ✓ or ✕ every row, or use the column buttons at the top. ✓ both on the same change combines the two.`
          : "Every change needs a choice — ✓ keep or ✕ drop. ✓ both on the same change combines the two; ✕ both removes that entry. The file itself always stays."
        : "";

  const renderInkChoiceRow = (
    side: Side,
    id: string,
    has: boolean,
    unread: boolean,
    excerpt: string,
    extraClass = "",
    status = "Different",
  ) => {
    if (!rowVisible(id)) return null;
    const kept = pickOf(picks, id, side) === true;
    const dropped = pickOf(picks, id, side) === false;
    const label = sideLabel(side);
    return (
      <li
        key={id}
        className={[
          "lc-hub-conflict-note",
          "lc-hub-conflict-ink",
          extraClass,
          focusedId === id ? "is-focused" : "",
          kept ? "is-keep" : "",
          dropped ? "is-drop" : "",
          !has ? "is-missing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-note-id={has ? id : undefined}
        data-row-key={id}
        data-pick={kept ? "keep" : dropped ? "drop" : "undecided"}
        onClick={() => focusRow(id)}
      >
        <span className="lc-hub-conflict-note-kind">ink</span>
        <span className="lc-hub-conflict-note-excerpt">
          {!has ? "No entry on this device" : unread ? "Could not read handwriting" : excerpt}
        </span>
        {has && <span className="lc-hub-conflict-note-flag">{status}</span>}
        <span className="lc-hub-conflict-note-actions">
          <button
            type="button"
            data-action="keep"
            aria-pressed={kept}
            disabled={!has || unread || (side === "server" && serverMissing)}
            aria-label={`Keep ${label} handwriting`}
            title={
              kept
                ? "This handwriting is kept — tap to reconsider. ✓ both merges both stroke sets."
                : `✓ keeps the ${label} copy. ✓ both merges both stroke sets.`
            }
            className={kept ? "lc-doc-confirm-btn lc-doc-confirm-yes" : "lc-doc-confirm-btn"}
            onClick={(event) => {
              event.stopPropagation();
              toggleKeep(side, id);
              focusRow(id);
            }}
          >
            ✓
          </button>
          <button
            type="button"
            data-action="drop"
            disabled={!has}
            aria-pressed={dropped}
            aria-label={`Drop ${label} handwriting`}
            title={
              dropped
                ? "This handwriting will be removed — tap to reconsider. ✕ both sides keeps the file with no ink on this page."
                : `✕ drops the ${label} copy. ✕ both sides keeps the file with no ink on this page.`
            }
            className={dropped ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"}
            onClick={(event) => {
              event.stopPropagation();
              toggleDrop(side, id);
              focusRow(id);
            }}
          >
            ✕
          </button>
        </span>
      </li>
    );
  };

  const renderInkRows = (side: Side) => (
    <>
      {padInkRows.map((row) => {
        const id = inkPageRowId(row.pageId);
        const has = side === "local" ? row.hasLocal : row.hasServer;
        const unread = side === "server" && serverInkUnread;
        return renderInkChoiceRow(
          side,
          id,
          has,
          unread,
          row.pageId === 0 ? "Handwriting across page boundaries" : `Handwriting (page ${row.pageId})`,
          "",
          statusFor(id, row.hasLocal, row.hasServer) === "Different" && conflict.kind === "annotate" && inkComparisons[row.pageId] !== false
            ? "Not verified" : statusFor(id, row.hasLocal, row.hasServer),
        );
      })}
      {fnInkRows.map((row) => {
        if (rows.some((note) => footnoteOwnsBoard(note, row.wbId))) return null;
        const id = footnoteInkPageRowId(row.wbId, row.pageId);
        const has = side === "local" ? row.hasLocal : row.hasServer;
        return renderInkChoiceRow(
          side,
          id,
          has,
          false,
          `Scratch (${row.wbId}, page ${row.pageId})`,
          "",
          statusFor(id, row.hasLocal, row.hasServer),
        );
      })}
    </>
  );

  const showInkOn = (side: Side): boolean => {
    if ((side === "local" ? inkHits.localOps : inkHits.serverOps).length > 0) return true;
    if (padInkRows.length === 0) {
      return (
        inkCount(
          side === "local" ? conflict.localInkPageIds : conflict.hubInkPageIds,
          side === "local" ? conflict.localInk : conflict.serverInk,
        ) > 0
      );
    }
    return padInkRows.some((row) => (side === "local" ? row.hasLocal : row.hasServer));
  };

  const droppedInkPages = (side: Side): number[] =>
    padInkRows
      .filter((row) => pickOf(picks, inkPageRowId(row.pageId), side) === false)
      .map((row) => row.pageId);

  const keptInkPages = (side: Side): number[] =>
    padInkRows
      .filter((row) => pickOf(picks, inkPageRowId(row.pageId), side) === true)
      .map((row) => row.pageId);

  const renderPane = (side: Side) => {
    const body = side === "local" ? conflict.local : conflict.server;
    const appState = padBoardAppState(body);
    const lined = linedPitchStateFromAppState(appState);
    const hasChoices = idsOnSide(side, true).length > 0;
    const at = updatedAtOf(body);
    const verdict = paneVerdict(side);
    const label = sideLabel(side);
    const keepBlocked = side === "server" && serverMissing;
    /*
     * The page shows this side's copy until you drop it.
     *
     * ✓ on a side keeps drawing that copy; ✕ hides it. Undecided still shows
     * the page and its marks while you decide.
     *
     * Tapping a row scrolls that page in. A column ✓ at the top is the same
     * keep-this-drop-the-other rule applied to every row at once.
     */
    const keptNotes = notesOf(body).filter((note) => pickOf(picks, note.id, side) !== false);
    return (
      <section className="lc-hub-conflict-pane" data-side={side} data-verdict={verdict}>
        <header className="lc-hub-conflict-pane-head">
          <span className="lc-hub-conflict-tab">{label}</span>
          <span className="lc-hub-conflict-pane-updated">
            {at != null ? new Date(at).toLocaleString() : ""}
          </span>
          <Tip
            tip={
              verdict === "keep"
                ? `Every ${label} copy is kept — tap to clear this column`
                : `✓ keeps every ${label} change and discards the other column. Keep both columns to combine them.`
            }
          >
            <button
              type="button"
              data-action="keep"
              aria-pressed={verdict === "keep"}
              disabled={keepBlocked || !hasChoices}
              aria-label={`Keep every ${label} copy`}
              className={
                verdict === "keep"
                  ? "lc-doc-confirm-btn lc-doc-confirm-yes"
                  : "lc-doc-confirm-btn"
              }
              onClick={() => onPaneKeep(side)}
            >
              ✓
            </button>
          </Tip>
          <Tip
            tip={
              verdict === "reject"
                ? `Every ${label} change will be dropped — tap to clear this column`
                : `✕ drops every ${label} change. The file itself stays. The other column is left as-is.`
            }
          >
            <button
              type="button"
              data-action="drop"
              aria-pressed={verdict === "reject"}
              aria-label={`Drop every ${label} change`}
              disabled={!hasChoices}
              className={
                verdict === "reject" ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"
              }
              onClick={() => onPaneDrop(side)}
            >
              ✕
            </button>
          </Tip>
        </header>
        <div className="lc-hub-conflict-pane-body">
          {!hasChoices && !inkLoading && <p className="lc-muted">No differing marks or handwriting on this side.</p>}
          <ConflictPagePreview
            hash={docHash}
            page={focusPage}
            notes={keptNotes}
            inkPages={side === "local" ? localInkPages : serverInkPages}
            showInk={showInkOn(side)}
            droppedPages={droppedInkPages(side)}
            keptPages={keptInkPages(side)}
            bytes={bytes}
            filmScope={filmScopeBase ? `${filmScopeBase}-${side}` : undefined}
            sourceText={
              typeof (body as AnnotatePadDto | null)?.source === "string"
                ? (body as AnnotatePadDto).source
                : undefined
            }
            sceneWidth={conflict.kind === "annotate" ? conflictDocumentWidth(body, sceneWidth) : sceneWidth}
            pageFrames={listFrames.length > 0 ? listFrames : pageFrames}
            pageCount={
              conflict.kind === "whiteboard"
                ? Math.max(padPageCount(conflict), listFrames.length)
                : undefined
            }
            linedPitchPair={lined.pair}
            linedRule={lined.rule}
            linedPaperMode={linedPaperModeFromAppState(appState)}
            focusKey={`${focusedId}:${focusRevision}`}
            decodedInk={side === "local" ? inkHits.localShards : inkHits.serverShards}
            inkLoading={inkLoading}
            selectedPageOnly
            revealInk={revealInk}
          />
          <ol
            ref={node => { if (node) listRefs.current[side] = node; else delete listRefs.current[side]; }}
            onScroll={event => {
              const other = listRefs.current[side === "local" ? "server" : "local"];
              if (other && Math.abs(other.scrollTop - event.currentTarget.scrollTop) > 1) other.scrollTop = event.currentTarget.scrollTop;
            }}
            className={["lc-hub-conflict-list", pickingStarted && !valid ? "is-picking" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            {renderInkRows(side)}
            {rows.map((row) => {
              const own = side === "local" ? row.local : row.server;
              const note = own ?? row.local ?? row.server;
              if (!note) return null;
              const parts = (partsByNote.get(row.id) ?? []).filter(part => rowVisible(part.id));
              const nestedInk = fnInkRows.filter((ink) => footnoteOwnsBoard(row, ink.wbId));
              const visibleNestedInk = nestedInk.filter(ink => rowVisible(footnoteInkPageRowId(ink.wbId, ink.pageId)));
              if (!rowVisible(row.id) && !visibleNestedInk.length && !parts.length) return null;
              const childCount = parts.length + visibleNestedInk.length;
              const expanded = collapsed[row.id] !== true;
              return (
                <li key={`${side}:${row.id}`} className="lc-hub-conflict-entry">
                  <ul className="lc-hub-conflict-entry-list">
                    <NoteRow
                      id={row.id}
                      kind={note.kind}
                      excerpt={note.excerpt}
                      side={side}
                      sameId={row.sameId}
                      differs={row.differs}
                      kept={pickOf(picks, row.id, side) === true}
                      dropped={pickOf(picks, row.id, side) === false}
                      focused={focusedId === row.id}
                      sideLabel={label}
                      missing={!own}
                      status={statusFor(row.id, Boolean(row.local), Boolean(row.server))}
                      expanded={expanded}
                      childCount={childCount}
                      onKeep={toggleKeep}
                      onDrop={toggleDrop}
                      onFocus={focusRow}
                      onToggleExpand={() =>
                        setCollapsed((current) => ({
                          ...current,
                          [row.id]: !current[row.id],
                        }))
                      }
                    />
                    {expanded
                      ? parts.map((part) => {
                          const has = side === "local" ? part.hasLocal : part.hasServer;
                          return (
                            <NoteRow
                              key={`${side}:${part.id}`}
                              id={part.id}
                              kind={PART_KIND_LABEL[part.kind]}
                              excerpt={part.label}
                              side={side}
                              sameId={part.hasLocal && part.hasServer}
                              differs={part.hasLocal && part.hasServer}
                              kept={inheritedPick(picks, part.id, row.id, side) === true}
                              dropped={inheritedPick(picks, part.id, row.id, side) === false}
                              focused={focusedId === part.id}
                              sideLabel={label}
                              missing={!has}
                              status={statusFor(part.id,part.hasLocal,part.hasServer)}
                              part
                              onKeep={toggleKeep}
                              onDrop={toggleDrop}
                              onFocus={focusRow}
                            />
                          );
                        })
                      : null}
                    {expanded
                      ? visibleNestedInk.map((ink) => {
                          const id = footnoteInkPageRowId(ink.wbId, ink.pageId);
                          const has = side === "local" ? ink.hasLocal : ink.hasServer;
                          return renderInkChoiceRow(
                            side,
                            id,
                            has,
                            false,
                            `Scratch (${ink.wbId}, page ${ink.pageId})`,
                            "is-part",
                            statusFor(id, ink.hasLocal, ink.hasServer),
                          );
                        })
                      : null}
                  </ul>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
    );
  };

  const navigationIds = choiceIds.filter(rowVisible);
  const navigationIndex = navigationIds.indexOf(focusedId);

  return (
    <div
      className={["lc-hub-conflict", pickingStarted && !valid ? "is-picking" : ""]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label="Sync conflict"
    >
      <header className="lc-hub-conflict-head">
        <strong>Compare changes · {nameOf(conflict)}</strong>
        <label className="lc-hub-conflict-filter">
          <input type="checkbox" checked={differencesOnly} onChange={event => setDifferencesOnly(event.target.checked)} />
          Differences only
        </label>
        <span className="lc-hub-conflict-filter-help">
          {Array.from(sameIds).filter(id => picks[id]?.local && picks[id]?.server).length} matching · kept
        </span>
        <label className="lc-hub-conflict-filter"><input type="checkbox" checked={revealInk} onChange={event => setRevealInk(event.target.checked)}/> Reveal ink</label>
        <span className="lc-hub-conflict-filter-help">Page {focusPage}</span>
        <nav className="lc-hub-conflict-navigation" aria-label="Merge entries">
          <button type="button" className="lc-secondary" disabled={navigationIndex <= 0} onClick={() => focusRow(navigationIds[navigationIndex-1])}>Previous</button>
          <button type="button" className="lc-secondary" disabled={!navigationIds.length || navigationIndex >= navigationIds.length-1} onClick={() => focusRow(navigationIds[navigationIndex+1])}>Next</button>
        </nav>
      </header>
      <div className="lc-hub-conflict-split">
        {renderPane("local")}
        <span className="lc-hub-conflict-sash" aria-hidden="true" />
        {renderPane("server")}
      </div>
      <footer className="lc-hub-conflict-actions">
        <span className={error && !busy ? "lc-hub-conflict-error" : "lc-muted"}>
          {busy
            ? "Writing your choice…"
            : error
              ? error
              : valid
              ? inkChoice() === "none" && !padInkRows.some(row => picks[inkPageRowId(row.pageId)]?.local || picks[inkPageRowId(row.pageId)]?.server)
                ? "Ready — the file stays, with no handwriting."
                : "Ready — Keep writes this mix to the hub. Sync on the other device to match."
              : whyDisabled}
        </span>
        <button
          type="button"
          disabled={!valid || busy}
          className="lc-hub-conflict-resolve"
          title={
            valid
              ? "Write this choice here and on the hub"
              : whyDisabled || "Choose each change first"
          }
          onClick={onResolveTap}
        >
          Keep selection
        </button>
      </footer>
    </div>
  );
}
