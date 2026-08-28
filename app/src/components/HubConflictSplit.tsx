/**
 * The conflict split: Local on the left, the other device on the right.
 *
 * The walk stopped before applying anything, so both panes read from the
 * stash — pad bodies and ink frozen at stop time. Pane ✓ keeps that copy of
 * the document; pane ✕ rejects it and keeps the other (rejecting both copies
 * of the file is impossible). Handwriting is a separate row: ✓ one side, ✓
 * both (merge), or ✕ both (no ink).
 */

import { useMemo, useState } from "react";

import type { AnnotatePadDto, InkPageDto } from "../api/client";
import type { DocFootnote } from "../util/docFootnotes";
import { Tip } from "./Tip";
import {
  INK_ROW_ID,
  type FootnoteDiffRow,
  type HubConflictResolution,
  type HubInkChoice,
  type HubPadConflict,
  footnoteDiffRows,
  mergeFootnotes,
} from "../util/hubConflictStash";

export interface HubConflictSplitProps {
  conflict: HubPadConflict | null;
  /** True while the resolve itself (IDB write + hub PUT) is running. */
  busy?: boolean;
  /** Right-pane name: Tablet when this device is the desktop, Desktop on the tablet. */
  otherLabel?: string;
  onResolve(resolution: HubConflictResolution): void;
}

/** Per-pane verdict; undecided until the reader touches that side. */
type Verdict = "undecided" | "keep" | "reject";

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

/** One footnote row inside one pane; ✓ here keeps this pane's copy. */
function NoteRow({
  note,
  side,
  sameId,
  differs,
  kept,
  sideLabel,
  onToggle,
}: {
  note: DocFootnote | null;
  side: "local" | "server";
  sameId: boolean;
  differs: boolean;
  kept: boolean;
  sideLabel: string;
  onToggle(side: "local" | "server", id: string): void;
}) {
  if (!note) return null;
  return (
    <li
      className={[
        "lc-hub-conflict-note",
        sameId ? "is-same-id" : "",
        differs ? "is-differs" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="lc-hub-conflict-note-kind">{note.kind}</span>
      <span className="lc-hub-conflict-note-excerpt">{note.excerpt}</span>
      {differs ? <span className="lc-hub-conflict-note-flag">changed on both</span> : null}
      <button
        type="button"
        aria-pressed={kept}
        aria-label={`Keep ${sideLabel} copy of note`}
        title={kept ? "This copy is kept — tap to drop it" : `✓ keeps the ${sideLabel} copy`}
        className={kept ? "lc-doc-confirm-btn lc-doc-confirm-yes" : "lc-doc-confirm-btn"}
        onClick={() => onToggle(side, note.id)}
      >
        ✓
      </button>
    </li>
  );
}

/** Tap cycle for one mark's copy: absent → keep → drop → absent. */
function nextPick(cur: boolean | undefined): boolean | undefined {
  if (cur === undefined) return true;
  return cur === true ? false : undefined;
}

export function HubConflictSplit({
  conflict,
  busy = false,
  otherLabel = "Tablet",
  onResolve,
}: HubConflictSplitProps) {
  const [verdicts, setVerdicts] = useState<{ local: Verdict; server: Verdict }>({
    local: "undecided",
    server: "undecided",
  });
  /** Per-mark overrides: true keeps, false drops, absent follows the pane. */
  const [picks, setPicks] = useState<Record<string, { local?: boolean; server?: boolean }>>({});

  const sideLabel = (side: "local" | "server") => (side === "local" ? "Local" : otherLabel);

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    const notesOf = (body: HubPadConflict["local"] | HubPadConflict["server"]) =>
      Array.isArray((body as AnnotatePadDto | null)?.footnotes)
        ? ((body as AnnotatePadDto).footnotes as DocFootnote[])
        : [];
    return footnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  const setVerdict = (side: "local" | "server", verdict: Verdict) => {
    if (side === "server" && verdict === "keep" && conflict?.server == null) return;
    setPicks({});
    setVerdicts((current) => {
      const otherSide = side === "local" ? "server" : "local";
      if (verdict === "reject") {
        // Cannot throw away both copies of the file. A second ✕ is a no-op.
        if (current[otherSide] === "reject") return current;
        return { ...current, [side]: "reject", [otherSide]: "keep" } as typeof current;
      }
      return { ...current, [side]: verdict } as typeof current;
    });
  };

  const defaultKeep = (side: "local" | "server"): boolean => verdicts[side] === "keep";

  const effectiveKeep = (id: string, side: "local" | "server"): boolean =>
    picks[id]?.[side] ?? defaultKeep(side);

  const toggleNote = (side: "local" | "server", id: string) => {
    setPicks((current) => ({
      ...current,
      [id]: { ...current[id], [side]: nextPick(current[id]?.[side]) },
    }));
  };

  const serverMissing = Boolean(conflict) && conflict!.server == null;

  const notesHomed = rows.every((row) => {
    if (effectiveKeep(row.id, "local") || effectiveKeep(row.id, "server")) return true;
    const stranded =
      (Boolean(row.local) && verdicts.local === "keep") ||
      (Boolean(row.server) && verdicts.server === "keep");
    return !stranded;
  });
  const valid =
    Boolean(conflict) &&
    (verdicts.local === "keep" || (verdicts.server === "keep" && !serverMissing)) &&
    notesHomed;

  const inkChoice = (): HubInkChoice => {
    const localInk = effectiveKeep(INK_ROW_ID, "local");
    const serverInk = effectiveKeep(INK_ROW_ID, "server");
    if (localInk && serverInk) return "merged";
    if (localInk) return "local";
    if (serverInk) return "server";
    return "none";
  };

  const onResolveTap = () => {
    if (!conflict || !valid) return;
    const ink = inkChoice();
    const explicitNotes = Object.entries(picks).some(
      ([id, pick]) =>
        id !== INK_ROW_ID && (pick.local !== undefined || pick.server !== undefined),
    );
    if (explicitNotes || (verdicts.local === "keep" && verdicts.server === "keep")) {
      if (conflict.kind !== "annotate") {
        onResolve({ pick: "local", ink });
        return;
      }
      const resolved: Record<string, { local: boolean; server: boolean }> = {};
      for (const row of rows) {
        resolved[row.id] = {
          local: effectiveKeep(row.id, "local"),
          server: effectiveKeep(row.id, "server"),
        };
      }
      const merged = mergeFootnotes(
        rows.map((row) => row.local).filter(Boolean) as DocFootnote[],
        rows.map((row) => row.server).filter(Boolean) as DocFootnote[],
        { local: true, server: true },
        resolved,
      );
      onResolve({ pick: "merged", footnotes: merged, ink });
      return;
    }
    onResolve({
      pick: verdicts.server === "keep" ? "server" : "local",
      ink,
    });
  };

  if (!conflict) return null;

  const rejectBlocked = (side: "local" | "server") => {
    const otherSide = side === "local" ? "server" : "local";
    return verdicts[otherSide] === "reject";
  };

  const whyDisabled = !conflict
    ? ""
    : serverMissing && verdicts.local !== "keep"
      ? "The other copy could not be read, so only this device's copy can be kept."
      : verdicts.local !== "keep" && verdicts.server !== "keep"
        ? `✓ Local, ✓ ${otherLabel}, or ✓ both. ✕ one side keeps the other. You cannot throw away both copies of the file.`
        : !notesHomed
          ? "Every highlight on a kept copy needs a home — ✓ that note on at least one side."
          : "";

  const renderInkRow = (side: "local" | "server") => {
    const pages = side === "local" ? conflict.localInk : conflict.serverInk;
    const n = inkCount(pages);
    const kept = effectiveKeep(INK_ROW_ID, side);
    const pageHint =
      conflict.inkPageId != null ? `page ${conflict.inkPageId}` : n === 1 ? "1 page" : `${n} pages`;
    return (
      <li className="lc-hub-conflict-note lc-hub-conflict-ink">
        <span className="lc-hub-conflict-note-kind">ink</span>
        <span className="lc-hub-conflict-note-excerpt">
          {n > 0 ? `Handwriting (${pageHint})` : "No handwriting"}
        </span>
        <button
          type="button"
          aria-pressed={kept}
          aria-label={`Keep ${sideLabel(side)} handwriting`}
          title={
            kept
              ? "This handwriting is kept — tap to drop it. ✕ both sides keeps the file with no ink."
              : `✓ keeps ${sideLabel(side)} handwriting. ✓ both merges both stroke sets.`
          }
          className={kept ? "lc-doc-confirm-btn lc-doc-confirm-yes" : "lc-doc-confirm-btn"}
          onClick={() => toggleNote(side, INK_ROW_ID)}
        >
          ✓
        </button>
      </li>
    );
  };

  const renderPane = (side: "local" | "server") => {
    const body = side === "local" ? conflict.local : conflict.server;
    const at = updatedAtOf(body);
    const verdict = verdicts[side];
    const blocked = rejectBlocked(side);
    const label = sideLabel(side);
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
                ? `This whole ${label} copy is kept`
                : `✓ keeps this device's entire ${label} copy — notes and the default for ink`
            }
          >
            <button
              type="button"
              aria-pressed={verdict === "keep"}
              aria-label={`Keep the ${label} copy entirely`}
              className={
                verdict === "keep"
                  ? "lc-doc-confirm-btn lc-doc-confirm-yes"
                  : "lc-doc-confirm-btn"
              }
              onClick={() => setVerdict(side, verdict === "keep" ? "undecided" : "keep")}
            >
              ✓
            </button>
          </Tip>
          <Tip
            tip={
              blocked
                ? `Need one copy of the file. To drop only handwriting, ✕ Ink on both sides.`
                : verdict === "reject"
                  ? `Rejected — tap to reconsider`
                  : `✕ throws the ${label} copy away and keeps ${side === "local" ? otherLabel : "Local"}`
            }
          >
            <button
              type="button"
              aria-pressed={verdict === "reject"}
              aria-label={
                blocked
                  ? `Cannot reject both copies of the document`
                  : `Reject the ${label} copy`
              }
              className={
                verdict === "reject" ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"
              }
              onClick={() => {
                if (blocked) return;
                setVerdict(side, verdict === "reject" ? "undecided" : "reject");
              }}
            >
              ✕
            </button>
          </Tip>
        </header>
        <div className="lc-hub-conflict-pane-body">
          <ol className="lc-hub-conflict-list">
            {renderInkRow(side)}
            {rows.map((row) => (
              <NoteRow
                key={`${side}:${row.id}`}
                note={side === "local" ? row.local : row.server}
                side={side}
                sameId={row.sameId}
                differs={row.differs}
                kept={effectiveKeep(row.id, side)}
                sideLabel={label}
                onToggle={toggleNote}
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
                : inkChoice() === "merged"
                  ? "Ready — highlights and handwriting from both sides."
                  : "Ready."
              : whyDisabled}
        </span>
        <button
          type="button"
          disabled={!valid || busy}
          className="lc-hub-conflict-resolve"
          title={
            valid
              ? "Write this choice here and on the hub"
              : whyDisabled || "Choose a copy first"
          }
          onClick={onResolveTap}
        >
          Keep selection
        </button>
      </footer>
    </div>
  );
}
