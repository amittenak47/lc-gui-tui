/**
 * The conflict split: Local on the left, the other device on the right.
 *
 * Nothing has been written yet. Each row (handwriting, each note) is its own
 * choice: ✓ that copy, ✓ both (keep both / merge ink), or ✕ both (drop that
 * entry). The file itself always stays. Top ✓ / ✕ fill a whole column without
 * wiping the other side. Keep is enabled once every row is settled, then PUT
 * to the hub so the other device matches on Sync.
 */

import { useMemo, useState } from "react";

import type { AnnotatePadDto, InkPageDto } from "../api/client";
import type { DocFootnote } from "../util/docFootnotes";
import { conflictFocusPage } from "../util/conflictPage";
import { Tip } from "./Tip";
import { ConflictPagePreview } from "./ConflictPagePreview";
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
          title={kept ? "This copy is kept — tap to reconsider" : `✓ keeps the ${sideLabel} copy`}
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
        ? "Every change needs a choice — ✓ keep or ✕ drop. ✓ both keeps both copies; ✕ both removes that entry. The file itself always stays."
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

  const renderPane = (side: Side) => {
    const body = side === "local" ? conflict.local : conflict.server;
    const at = updatedAtOf(body);
    const verdict = paneVerdict(side);
    const label = sideLabel(side);
    const keepBlocked = side === "server" && serverMissing;
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
        <div className="lc-hub-conflict-pane-body">
          <ConflictPagePreview hash={docHash} page={focusPage} />
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
