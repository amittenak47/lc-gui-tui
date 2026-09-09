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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AnnotatePadDto, InkPageDto, LcClient } from "../api/client";
import type { PageFrame } from "../canvas/inkPageIndex";
import type { DocFootnote } from "../util/docFootnotes";
import { conflictFocusPage, inkDtosHavePage, mergeInkDtos } from "../util/conflictPage";
import { loadConflictPreviewInkPage } from "../util/inkSync";
import { Tip } from "./Tip";
import { ConflictPagePreview } from "./ConflictPagePreview";
import { FootnoteOverview } from "../modes/FootnoteOverview";
import {
  INK_ROW_ID,
  type FootnoteDiffRow,
  type HubConflictResolution,
  type HubInkChoice,
  type HubPadConflict,
  entrySettled,
  footnoteInkDiffRows,
  footnoteInkPageRowId,
  inkChoiceFromPick,
  inkPageRowId,
  isInkRowId,
  mergeFootnotes,
  padInkDiffRows,
  parseFootnoteInkPageRowId,
  parseInkPageRowId,
  visibleFootnoteDiffRows,
} from "../util/hubConflictStash";

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

function NoteRow({
  note,
  side,
  sameId,
  differs,
  kept,
  dropped,
  focused,
  sideLabel,
  onKeep,
  onDrop,
  onFocus,
}: {
  note: DocFootnote | null;
  side: Side;
  sameId: boolean;
  differs: boolean;
  kept: boolean;
  dropped: boolean;
  focused: boolean;
  sideLabel: string;
  onKeep(side: Side, id: string): void;
  onDrop(side: Side, id: string): void;
  onFocus(id: string): void;
}) {
  if (!note) return null;
  return (
    <li
      className={[
        "lc-hub-conflict-note",
        sameId ? "is-same-id" : "",
        differs ? "is-differs" : "",
        focused ? "is-focused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-note-id={note.id}
      data-pick={kept ? "keep" : dropped ? "drop" : "undecided"}
      onClick={() => onFocus(note.id)}
    >
      <span className="lc-hub-conflict-note-kind">{note.kind}</span>
      <span className="lc-hub-conflict-note-excerpt">{note.excerpt}</span>
      {differs ? <span className="lc-hub-conflict-note-flag">changed on both</span> : null}
      <span className="lc-hub-conflict-note-actions">
        <button
          type="button"
          data-action="keep"
          aria-pressed={kept}
          aria-label={`Keep ${sideLabel} copy of note`}
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
            onKeep(side, note.id);
            onFocus(note.id);
          }}
        >
          ✓
        </button>
        <button
          type="button"
          data-action="drop"
          aria-pressed={dropped}
          aria-label={`Drop ${sideLabel} copy of note`}
          title={
            dropped
              ? "This copy will be removed — tap to reconsider"
              : `✕ drops the ${sideLabel} copy. ✕ both sides removes this note.`
          }
          className={dropped ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"}
          onClick={(event) => {
            event.stopPropagation();
            onDrop(side, note.id);
            onFocus(note.id);
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
  const [overlayInk, setOverlayInk] = useState<{
    local: InkPageDto[];
    server: InkPageDto[];
  }>({ local: [], server: [] });
  const overlayInkRef = useRef(overlayInk);
  overlayInkRef.current = overlayInk;
  const overlayTriedRef = useRef<Set<number>>(new Set());

  const sideLabel = (side: Side) => (side === "local" ? "Local" : otherLabel);

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    return visibleFootnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  const padInkRows = useMemo(
    () => (conflict ? padInkDiffRows(conflict) : []),
    [conflict],
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
    const resolved: Record<string, { local: boolean; server: boolean }> = {};
    for (const row of rows) {
      resolved[row.id] = {
        local: pickOf(picks, row.id, "local") === true,
        server: pickOf(picks, row.id, "server") === true,
      };
    }
    const boardRemints: Record<string, string> = {};
    const merged = mergeFootnotes(
      notesOf(conflict.local),
      notesOf(conflict.server),
      { local: false, server: false },
      resolved,
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
    const row = rows.find((row) => row.id === focusedId);
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
    if (inkDtosHavePage(localPages, focusPage) && inkDtosHavePage(serverPages, focusPage)) {
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
        ? "Every change needs a choice — ✓ keep or ✕ drop. ✓ both on the same change combines the two; ✕ both removes that entry. The file itself always stays."
        : "";

  const renderInkChoiceRow = (
    side: Side,
    id: string,
    has: boolean,
    unread: boolean,
    excerpt: string,
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
          focusedId === id ? "is-focused" : "",
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

  const showInkOn = (side: Side, page: number): boolean => {
    const disputed = padInkRows.find((row) => row.pageId === page);
    if (!disputed) {
      return (
        inkCount(
          side === "local" ? conflict.localInkPageIds : conflict.hubInkPageIds,
          side === "local" ? conflict.localInk : conflict.serverInk,
        ) > 0
      );
    }
    // Show this side's copy until it is dropped, so the page is not blank
    // before anyone has ticked a row.
    return pickOf(picks, inkPageRowId(page), side) !== false;
  };

  /*
   * Where each pane's hub sits.
   *
   * The card portals out of the tree and positions itself `fixed`, so the two
   * of them would otherwise clamp to the same viewport box and land on top of
   * each other — the one arrangement that makes comparing two copies useless.
   * Anchored on its own pane, each stays over the copy it describes.
   *
   * Measured from a layout effect rather than a ref callback: a callback ref
   * is a new function every render, so React detaches and reattaches it each
   * pass, and measuring there wrote state on every one of them.
   */
  const paneBodyRefs = useRef<Record<Side, HTMLDivElement | null>>({
    local: null,
    server: null,
  });
  const setPaneBody = (side: Side) => (node: HTMLDivElement | null) => {
    paneBodyRefs.current[side] = node;
  };
  const [hubAnchors, setHubAnchors] = useState<Record<Side, DOMRect | null>>({
    local: null,
    server: null,
  });
  /*
   * Which panes are showing a card, on the same rule the marks follow: the
   * focused row, on a side that has been kept.
   */
  const hubSides: Side[] = (["local", "server"] as const).filter(
    (side) =>
      !isInkRowId(focusedId) &&
      rows.some((row) => row.id === focusedId) &&
      pickOf(picks, focusedId, side) === true,
  );
  const hubOpen = hubSides.length > 0;
  useLayoutEffect(() => {
    if (!hubOpen) {
      setHubAnchors((current) =>
        current.local === null && current.server === null
          ? current
          : { local: null, server: null },
      );
      return;
    }
    /*
     * Anchored to the mark, the way the card sits in the reader.
     *
     * The pane is the fallback and not the answer: a card floating in the
     * middle of a column is not obviously *about* anything, and there are two
     * of them here. The mark may not be placed yet — a PDF's text layer lands
     * after mount — so this keeps looking until it is, and stops as soon as
     * both sides have one.
     */
    /*
     * The band, not the pack around it.
     *
     * A pack is a bare `<span>` whose bands are absolutely positioned, so its
     * own box is zero-sized and sits wherever the first band's offset parent
     * puts it — anchoring to that clamped both cards into the top corner.
     *
     * Scanned rather than selected: a mark id is not guaranteed to be a legal
     * CSS identifier, and `CSS.escape` is not everywhere this runs.
     */
    const markIn = (side: Side): HTMLElement | null => {
      const body = paneBodyRefs.current[side];
      if (!body) return null;
      for (const pack of body.querySelectorAll<HTMLElement>(".lc-doc-footnote-pack")) {
        if (pack.dataset.footnoteId !== focusedId) continue;
        const band = pack.querySelector<HTMLElement>(".lc-doc-footnote-band");
        return band ?? pack;
      }
      return null;
    };
    /**
     * On screen, not merely in the tree.
     *
     * The pane is still scrolling to the mark when it first places, and a card
     * anchored to a box a thousand pixels above the viewport is a card in the
     * corner. Waiting for the mark to arrive is waiting for the scroll.
     */
    const settledOn = (side: Side): boolean => {
      const body = paneBodyRefs.current[side];
      const mark = markIn(side);
      if (!body || !mark) return false;
      const box = mark.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return false;
      const view = body.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    };
    const rectFor = (side: Side): DOMRect | null => {
      const body = paneBodyRefs.current[side];
      if (!body) return null;
      return (settledOn(side) ? markIn(side)! : body).getBoundingClientRect();
    };
    const onMark = settledOn;

    let frame = 0;
    let stop = 0;
    const settle = () => {
      setHubAnchors({ local: rectFor("local"), server: rectFor("server") });
      // Only the sides actually showing a card have a mark to wait for.
      return hubSides.every(onMark);
    };
    if (settle()) return;
    const tick = () => {
      if (settle()) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // A mark that never places would otherwise keep this running for the life
    // of the split; the pane rect it already has is the answer by then.
    stop = window.setTimeout(() => cancelAnimationFrame(frame), 2000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(stop);
    };
    // `picks` too: keeping a side is what puts its card on screen.
  }, [hubOpen, focusedId, picks]);

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
    /*
     * The card follows the tick too.
     *
     * It is the same change as the mark on the page, described in full, so it
     * answers to the same decision: a side that has not been kept shows
     * neither. Opening both cards for a row nobody had answered for put two
     * panels over two pages that were deliberately blank, and — since there
     * was no mark to sit under — left them floating in the middle of their
     * columns as well.
     *
     * Focus still chooses *which* row's card, so there is one per pane rather
     * than one per kept mark.
     */
    const focusedRow = isInkRowId(focusedId) ? null : rows.find((row) => row.id === focusedId);
    const focusedNote =
      focusedRow && pickOf(picks, focusedRow.id, side) === true
        ? (side === "local" ? focusedRow.local : focusedRow.server)
        : null;
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
        <div className="lc-hub-conflict-pane-body" ref={setPaneBody(side)}>
          <ConflictPagePreview
            hash={docHash}
            page={focusPage}
            notes={keptNotes}
            inkPages={
              side === "local"
                ? mergeInkDtos(conflict.localInk, overlayInk.local)
                : mergeInkDtos(conflict.serverInk, overlayInk.server)
            }
            showInk={showInkOn(side, focusPage)}
            bytes={bytes}
            filmScope={filmScopeBase ? `${filmScopeBase}-${side}` : undefined}
            sourceText={
              typeof (body as AnnotatePadDto | null)?.source === "string"
                ? (body as AnnotatePadDto).source
                : undefined
            }
            sceneWidth={sceneWidth}
            pageFrames={pageFrames}
          />
          {/*
            This pane's copy of the focused mark, in the real hub.

            One per pane, on that pane's own footnote — so Local's notes,
            boards and threads and the other device's sit side by side, which
            is what "changed on both" is actually asking you to compare. The
            live hub in the workspace reads this device's set and could only
            ever show one of them.

            Read-only: the reader is choosing between two copies, and Keep is
            the only write in this flow. Anything typed into the losing copy
            would be thrown away without saying so.
          */}
          {focusedNote ? (
            <div className="lc-hub-conflict-hub">
              <FootnoteOverview
                footnote={focusedNote}
                anchorRect={hubAnchors[side]}
                readOnly
                onChange={() => {}}
                onClose={() => setFocusedId(INK_ROW_ID)}
                threadMessages={() => []}
                onSendCoach={() => {}}
                onOpenExternal={() => {}}
                subMarkMode={null}
                onSubMarkModeChange={() => {}}
              />
            </div>
          ) : null}
          <ol className="lc-hub-conflict-list">
            {renderInkRows(side)}
            {rows.map((row) => (
              <NoteRow
                key={`${side}:${row.id}`}
                note={side === "local" ? row.local : row.server}
                side={side}
                sameId={row.sameId}
                differs={row.differs}
                kept={pickOf(picks, row.id, side) === true}
                dropped={pickOf(picks, row.id, side) === false}
                focused={focusedId === row.id}
                sideLabel={label}
                onKeep={toggleKeep}
                onDrop={toggleDrop}
                onFocus={setFocusedId}
              />
            ))}
          </ol>
        </div>
      </section>
    );
  };

  return (
    <div className="lc-hub-conflict" role="dialog" aria-modal="true" aria-label="Sync conflict">
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
