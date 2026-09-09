/**
 * The conflict split: Local on the left, the other device on the right.
 *
 * Nothing has been written yet. Each row (each handwriting page, each note)
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
import { loadConflictPreviewInkPage } from "../util/inkSync";
import { Tip } from "./Tip";
import { ConflictPagePreview } from "./ConflictPagePreview";
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
  visibleFootnoteDiffRows,
} from "../util/hubConflictStash";
import { linedPitchStateFromAppState } from "../util/linedPaperPref";
import { mergeConflictPageFrames, expandLumpedInkDiffRows, decodeConflictInkPages, inkPageIdsFromOps, conflictPaperFrames, whiteboardConflictFrames, whiteboardInkMergeRows } from "./conflictInkLayout";
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
  /** Hub client — used to GET one more ink page when a row is off the freeze preview. */
  client?: LcClient | null;
  /**
   * Test seam: one page of overlay ink. Production uses {@link loadConflictPreviewInkPage}.
   */
  fetchPreviewInk?: (
    pageId: number,
  ) => Promise<{ local: InkPageDto | null; server: InkPageDto | null }>;
}

type Side = "local" | "server";
type SidePick = { local?: boolean; server?: boolean };

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
      ]
        .filter(Boolean)
        .join(" ")}
      data-note-id={id}
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
      <span className="lc-hub-conflict-note-excerpt">{excerpt}</span>
      {differs ? <span className="lc-hub-conflict-note-flag">changed on both</span> : null}
      <span className="lc-hub-conflict-note-actions">
        <button
          type="button"
          data-action="keep"
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
  client = null,
  fetchPreviewInk,
}: HubConflictSplitProps) {
  const [picks, setPicks] = useState<Record<string, SidePick>>({});
  const [focusedId, setFocusedId] = useState<string>(INK_ROW_ID);
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
  }>({
    local: [],
    server: [],
    maxY: 0,
    localOps: [],
    serverOps: [],
  });

  const sideLabel = (side: Side) => (side === "local" ? "Local" : otherLabel);

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    return visibleFootnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  const previewFrames = useMemo(
    () =>
      mergeConflictPageFrames(
        pageFrames,
        whiteboardPageFramesFromPad(conflict?.local ?? null),
        whiteboardPageFramesFromPad(conflict?.server ?? null),
      ),
    [pageFrames, conflict],
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
    () => (conflict ? padInkDiffRows(conflict) : []),
    [conflict],
  );
  const padInkRows = useMemo(
    () =>
      conflict?.kind === "whiteboard"
        ? whiteboardInkMergeRows(
            basePadInkRows,
            listFrames,
            inkHits.localOps,
            inkHits.serverOps,
          )
        : expandLumpedInkDiffRows(basePadInkRows, listFrames, inkHits.local, inkHits.server),
    [conflict, basePadInkRows, listFrames, inkHits],
  );
  const fnInkRows = useMemo(
    () => (conflict ? footnoteInkDiffRows(conflict) : []),
    [conflict],
  );

  const serverMissing = Boolean(conflict) && conflict!.server == null;
  const serverInkUnread = Boolean(conflict) && conflict!.serverInk === null;

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

  const idsOnSide = (side: Side): string[] => {
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
    return ids;
  };

  const paneFilled = (side: Side, value: boolean): boolean => {
    const ids = idsOnSide(side);
    if (ids.length === 0) return false;
    return ids.every((id) => pickOf(picks, id, side) === value);
  };

  const setSideAll = (side: Side, value: boolean | undefined) => {
    if (side === "server" && serverMissing && value === true) return;
    const ids = idsOnSide(side);
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
      const ids = idsOnSide(side);
      const otherIds = idsOnSide(other);
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
    padInkRows.map((row) => ({
      pageId: row.pageId,
      choice: inkChoiceFromPick(picks[inkPageRowId(row.pageId)]),
    }));

  const footnoteInkPageChoices = () =>
    fnInkRows.map((row) => ({
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
  const lined = useMemo(
    () =>
      linedPitchStateFromAppState(
        padBoardAppState(conflict?.local ?? null) ??
          padBoardAppState(conflict?.server ?? null),
      ),
    [conflict],
  );
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
      setInkHits({ local: [], server: [], maxY: 0, localOps: [], serverOps: [] });
      return;
    }
    let gone = false;
    void (async () => {
      const [localOps, serverOps] = await Promise.all([
        decodeConflictInkPages(mergeInkDtos(conflict.localInk, overlayInk.local)),
        decodeConflictInkPages(mergeInkDtos(conflict.serverInk, overlayInk.server)),
      ]);
      if (gone) return;
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
      });
    })();
    return () => {
      gone = true;
    };
  }, [conflict, previewFrames, overlayInk]);
  const choiceIds = useMemo(() => {
    if (!conflict) return [];
    return [...new Set([...idsOnSide("local"), ...idsOnSide("server")])];
  }, [conflict, padInkRows, fnInkRows, rows]);
  const remainingChoices = choiceIds.filter((id) => {
    const hasLocal = idsOnSide("local").includes(id);
    const hasServer = idsOnSide("server").includes(id);
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
    setOverlayInk({ local: [], server: [] });
    overlayTriedRef.current = new Set();
  }, [conflict?.id]);

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
    const covers = (pages: readonly InkPageDto[], pageId: number) =>
      inkDtosHavePage(pages, pageId) ||
      (lumpedWhiteboard &&
        pageId >= 1 &&
        pages.some((page) => page.page_id <= 1 && Boolean(page.gz)));
    if (covers(localPages, focusPage) && covers(serverPages, focusPage)) {
      return;
    }
    if (overlayTriedRef.current.has(focusPage)) return;
    overlayTriedRef.current.add(focusPage);
    let gone = false;
    let finished = false;
    const load =
      fetchPreviewInk ??
      ((pageId: number) =>
        loadConflictPreviewInkPage(client, conflict.kind, conflict.id, pageId));
    void load(focusPage)
      .then((got) => {
        finished = true;
        if (gone) return;
        setOverlayInk((current) => ({
          local:
            got.local && !inkDtosHavePage(current.local, got.local.page_id)
              ? [...current.local, got.local]
              : current.local,
          server:
            got.server && !inkDtosHavePage(current.server, got.server.page_id)
              ? [...current.server, got.server]
              : current.server,
        }));
      })
      .catch(() => {
        finished = true;
        overlayTriedRef.current.delete(focusPage);
      });
    return () => {
      gone = true;
      if (!finished) overlayTriedRef.current.delete(focusPage);
    };
  }, [client, conflict, fetchPreviewInk, focusPage]);

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
  ) => {
    if (!has) return null;
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
        ]
          .filter(Boolean)
          .join(" ")}
        data-note-id={id}
        data-pick={kept ? "keep" : dropped ? "drop" : "undecided"}
        onClick={() => setFocusedId(id)}
      >
        <span className="lc-hub-conflict-note-kind">ink</span>
        <span className="lc-hub-conflict-note-excerpt">
          {unread ? "Could not read handwriting" : excerpt}
        </span>
        <span className="lc-hub-conflict-note-actions">
          <button
            type="button"
            data-action="keep"
            aria-pressed={kept}
            disabled={unread || (side === "server" && serverMissing)}
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
              setFocusedId(id);
            }}
          >
            ✓
          </button>
          <button
            type="button"
            data-action="drop"
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
              setFocusedId(id);
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
          `Handwriting (page ${row.pageId})`,
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
        );
      })}
    </>
  );

  const showInkOn = (side: Side): boolean => {
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
    const at = updatedAtOf(body);
    const verdict = paneVerdict(side);
    const label = sideLabel(side);
    const keepBlocked = side === "server" && serverMissing;
    /*
     * The page shows this side's copy until you drop it.
     *
     * ✓ on a side keeps drawing that copy; ✕ hides it. Undecided still shows
     * the page, so a whiteboard is not a blank pane while you decide. Marks
     * wait for a tick — they are a choice, not the paper.
     *
     * Tapping a row scrolls that page in. A column ✓ at the top is the same
     * keep-this-drop-the-other rule applied to every row at once.
     */
    const keptNotes = rows
      .map((row) => (pickOf(picks, row.id, side) === true ? (side === "local" ? row.local : row.server) : null))
      .filter((note): note is DocFootnote => Boolean(note));
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
              disabled={keepBlocked}
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
            sceneWidth={sceneWidth}
            pageFrames={listFrames.length > 0 ? listFrames : pageFrames}
            pageCount={
              conflict.kind === "whiteboard"
                ? Math.max(padPageCount(conflict), listFrames.length)
                : undefined
            }
            linedPitchPair={lined.pair}
            linedRule={lined.rule}
          />
          <ol
            className={["lc-hub-conflict-list", pickingStarted && !valid ? "is-picking" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            {renderInkRows(side)}
            {rows.map((row) => {
              const note = side === "local" ? row.local : row.server;
              if (!note) return null;
              const parts = footnotePartDiffs(row.local, row.server);
              const nestedInk = fnInkRows.filter((ink) => footnoteOwnsBoard(row, ink.wbId));
              const childCount = parts.length + nestedInk.length;
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
                      expanded={expanded}
                      childCount={childCount}
                      onKeep={toggleKeep}
                      onDrop={toggleDrop}
                      onFocus={setFocusedId}
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
                          if (!has) return null;
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
                              part
                              onKeep={toggleKeep}
                              onDrop={toggleDrop}
                              onFocus={setFocusedId}
                            />
                          );
                        })
                      : null}
                    {expanded
                      ? nestedInk.map((ink) => {
                          const id = footnoteInkPageRowId(ink.wbId, ink.pageId);
                          const has = side === "local" ? ink.hasLocal : ink.hasServer;
                          return renderInkChoiceRow(
                            side,
                            id,
                            has,
                            false,
                            `Scratch (${ink.wbId}, page ${ink.pageId})`,
                            "is-part",
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
        <strong>Both copies changed — {nameOf(conflict)}</strong>
        <span>
          {conflict.detail}. Local is this device; {otherLabel} is the other. Nothing has been
          written yet.
        </span>
      </header>
      <div className="lc-hub-conflict-split">
        {renderPane("local")}
        <span className="lc-hub-conflict-sash" aria-hidden="true" />
        {renderPane("server")}
      </div>
      <footer className="lc-hub-conflict-actions">
        <span className="lc-muted">
          {busy
            ? "Writing your choice…"
            : valid
              ? inkChoice() === "none"
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
