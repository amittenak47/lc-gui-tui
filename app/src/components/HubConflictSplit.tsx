/**
 * The conflict split: Local on the left, the other device on the right.
 *
 * Nothing has been written yet. Each row (handwriting, each note) is its own
 * choice: ✓ that copy, ✓ both, or ✕ both (drop that entry). What ✓ both means
 * depends on what the row is: one mark two devices both wrote on becomes one
 * mark carrying both sides' notes and boards, ink merges its strokes, and two
 * marks that merely share a page stay two. The file itself always stays. Top
 * ✓ / ✕ fill a whole column without wiping the other side. Keep is enabled
 * once every row is settled, then PUT to the hub so the other device matches
 * on Sync.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AnnotatePadDto, InkPageDto } from "../api/client";
import type { PageFrame } from "../canvas/inkPageIndex";
import type { DocFootnote } from "../util/docFootnotes";
import { conflictFocusPage } from "../util/conflictPage";
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
  footnoteDiffRows,
  mergeFootnotes,
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

function inkCount(pages: readonly InkPageDto[] | undefined): number {
  return pages?.length ?? 0;
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
}: HubConflictSplitProps) {
  const [picks, setPicks] = useState<Record<string, SidePick>>({});
  const [focusedId, setFocusedId] = useState<string>(INK_ROW_ID);

  const sideLabel = (side: Side) => (side === "local" ? "Local" : otherLabel);

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    const notesOf = (body: HubPadConflict["local"] | HubPadConflict["server"]) =>
      Array.isArray((body as AnnotatePadDto | null)?.footnotes)
        ? ((body as AnnotatePadDto).footnotes as DocFootnote[])
        : [];
    return footnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  const serverMissing = Boolean(conflict) && conflict!.server == null;

  const inkHas = (side: Side): boolean => {
    if (!conflict) return false;
    if (side === "local") {
      return Boolean(conflict.local) || inkCount(conflict.localInk) > 0;
    }
    return Boolean(conflict.server) || inkCount(conflict.serverInk) > 0;
  };

  const toggleKeep = (side: Side, id: string) => {
    if (side === "server" && serverMissing) return;
    setPicks((current) => {
      const now = current[id]?.[side];
      return { ...current, [id]: { ...current[id], [side]: now === true ? undefined : true } };
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
    if (inkHas(side)) ids.push(INK_ROW_ID);
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
        next[id] = { ...next[id], [side]: value };
      }
      return next;
    });
  };

  const onPaneKeep = (side: Side) => {
    setSideAll(side, paneFilled(side, true) ? undefined : true);
  };

  const onPaneDrop = (side: Side) => {
    setSideAll(side, paneFilled(side, false) ? undefined : false);
  };

  const paneVerdict = (side: Side): "undecided" | "keep" | "reject" => {
    if (paneFilled(side, true)) return "keep";
    if (paneFilled(side, false)) return "reject";
    return "undecided";
  };

  const inkChoice = (): HubInkChoice => {
    const localInk = pickOf(picks, INK_ROW_ID, "local") === true;
    const serverInk = pickOf(picks, INK_ROW_ID, "server") === true;
    if (localInk && serverInk) return "merged";
    if (localInk) return "local";
    if (serverInk) return "server";
    return "none";
  };

  const notesHomed = rows.every((row) =>
    entrySettled(Boolean(row.local), Boolean(row.server), picks[row.id]),
  );
  const inkHomed = entrySettled(inkHas("local"), inkHas("server"), picks[INK_ROW_ID]);
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
    if (pick !== "merged" || conflict.kind !== "annotate") {
      onResolve({ pick, ink });
      return;
    }
    const resolved: Record<string, { local: boolean; server: boolean }> = {};
    for (const row of rows) {
      resolved[row.id] = {
        local: pickOf(picks, row.id, "local") === true,
        server: pickOf(picks, row.id, "server") === true,
      };
    }
    const merged = mergeFootnotes(
      rows.map((row) => row.local).filter(Boolean) as DocFootnote[],
      rows.map((row) => row.server).filter(Boolean) as DocFootnote[],
      { local: false, server: false },
      resolved,
    );
    onResolve({ pick: "merged", footnotes: merged, ink });
  };

  const focusPage = useMemo(() => {
    if (!conflict) return 1;
    if (focusedId === INK_ROW_ID) {
      return conflictFocusPage({
        inkPageId: conflict.inkPageId,
        ink: [...(conflict.localInk ?? []), ...(conflict.serverInk ?? [])],
      });
    }
    const row = rows.find((row) => row.id === focusedId);
    return conflictFocusPage({
      note: row?.local ?? row?.server,
      inkPageId: conflict.inkPageId,
      ink: conflict.localInk,
    });
  }, [conflict, focusedId, rows]);

  if (!conflict) return null;

  const whyDisabled = !conflict
    ? ""
    : serverMissing
      ? "The other copy could not be read, so only this device's copy can be kept. ✓ Local (or each of its changes)."
      : !valid
        ? "Every change needs a choice — ✓ keep or ✕ drop. ✓ both on the same change combines the two; ✕ both removes that entry. The file itself always stays."
        : "";

  const renderInkRow = (side: Side) => {
    const pages = side === "local" ? conflict.localInk : conflict.serverInk;
    const n = inkCount(pages);
    const kept = pickOf(picks, INK_ROW_ID, side) === true;
    const dropped = pickOf(picks, INK_ROW_ID, side) === false;
    const pageHint =
      conflict.inkPageId != null ? `page ${conflict.inkPageId}` : n === 1 ? "1 page" : `${n} pages`;
    const label = sideLabel(side);
    return (
      <li
        className={[
          "lc-hub-conflict-note",
          "lc-hub-conflict-ink",
          focusedId === INK_ROW_ID ? "is-focused" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-pick={kept ? "keep" : dropped ? "drop" : "undecided"}
        onClick={() => setFocusedId(INK_ROW_ID)}
      >
        <span className="lc-hub-conflict-note-kind">ink</span>
        <span className="lc-hub-conflict-note-excerpt">
          {n > 0 ? `Handwriting (${pageHint})` : "No handwriting"}
        </span>
        <span className="lc-hub-conflict-note-actions">
          <button
            type="button"
            data-action="keep"
            aria-pressed={kept}
            disabled={side === "server" && serverMissing}
            aria-label={`Keep ${label} handwriting`}
            title={
              kept
                ? "This handwriting is kept — tap to reconsider. ✓ both merges both stroke sets."
                : `✓ keeps ${label} handwriting. ✓ both merges both stroke sets.`
            }
            className={kept ? "lc-doc-confirm-btn lc-doc-confirm-yes" : "lc-doc-confirm-btn"}
            onClick={(event) => {
              event.stopPropagation();
              toggleKeep(side, INK_ROW_ID);
              setFocusedId(INK_ROW_ID);
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
                ? "This handwriting will be removed — tap to reconsider. ✕ both sides keeps the file with no ink."
                : `✕ drops ${label} handwriting. ✕ both sides keeps the file with no ink.`
            }
            className={dropped ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"}
            onClick={(event) => {
              event.stopPropagation();
              toggleDrop(side, INK_ROW_ID);
              setFocusedId(INK_ROW_ID);
            }}
          >
            ✕
          </button>
        </span>
      </li>
    );
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
      focusedId !== INK_ROW_ID &&
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
     * The page shows what you have kept, and only that.
     *
     * ✓ on a side draws that side's copy in that side's pane; ✕ and undecided
     * draw nothing. So a row starts with neither pane showing anything, which
     * is the honest picture of a change nobody has answered for yet, and the
     * page fills in as you decide — one side, the other, or both. A column ✓
     * at the top is the same rule applied to every row at once.
     *
     * Deliberately not driven by focus. Tapping a row is asking to *see* it —
     * it scrolls that page in and opens the row's hub — and a tap that also
     * drew the mark made the page disagree with the ticks beside it, which is
     * the one thing this view has to get right.
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
    const focusedRow = focusedId === INK_ROW_ID ? null : rows.find((row) => row.id === focusedId);
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
                : `✓ keeps every ${label} change. The other column is left as-is.`
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
            inkPages={side === "local" ? conflict.localInk : conflict.serverInk}
            showInk={pickOf(picks, INK_ROW_ID, side) === true}
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
            {renderInkRow(side)}
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
