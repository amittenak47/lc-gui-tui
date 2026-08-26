/**
 * The conflict split: Local on the left, Server on the right, one choice.
 *
 * The walk stopped before applying anything, so both panes read from the
 * stash — the pad bodies frozen at stop time — not from IDB or the hub,
 * which either side could outdate mid-choice. Pane ✓ keeps that entire pane;
 * pane ✕ rejects it, which keeps the other by force (rejecting both would
 * leave nothing). An annotate pad also offers the footnote rules: same id on
 * both sides is highlighted, ✓ keeps that copy, a side with no ✓ drops its
 * copy, and a same-id-different-body mark ✓'d on both sides resolves to two
 * notes.
 *
 * The buttons are `.lc-doc-confirm-yes` / `-no` on purpose: conflict keeps
 * and rejects mean exactly what the quote sheet's keep and throw-away mean.
 */

import { useMemo, useState } from "react";

import type { AnnotatePadDto } from "../api/client";
import type { DocFootnote } from "../util/docFootnotes";
import {
  type FootnoteDiffRow,
  type HubConflictResolution,
  type HubPadConflict,
  footnoteDiffRows,
  mergeFootnotes,
} from "../util/hubConflictStash";

export interface HubConflictSplitProps {
  conflict: HubPadConflict | null;
  /** True while the resolve itself (IDB write + hub PUT) is running. */
  busy?: boolean;
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

/** One footnote row inside one pane; ✓ here keeps this pane's copy. */
function NoteRow({
  note,
  side,
  sameId,
  differs,
  kept,
  onToggle,
}: {
  note: DocFootnote | null;
  side: "local" | "server";
  sameId: boolean;
  differs: boolean;
  kept: boolean;
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
        aria-label={`Keep ${side} copy of note`}
        title={kept ? "This copy is kept — tap to drop it" : "✓ keeps this copy"}
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

export function HubConflictSplit({ conflict, busy = false, onResolve }: HubConflictSplitProps) {
  const [verdicts, setVerdicts] = useState<{ local: Verdict; server: Verdict }>({
    local: "undecided",
    server: "undecided",
  });
  /** Per-mark overrides: true keeps, false drops, absent follows the pane. */
  const [picks, setPicks] = useState<Record<string, { local?: boolean; server?: boolean }>>({});

  const rows = useMemo<FootnoteDiffRow[]>(() => {
    if (!conflict || conflict.kind !== "annotate") return [];
    const notesOf = (body: HubPadConflict["local"] | HubPadConflict["server"]) =>
      Array.isArray((body as AnnotatePadDto | null)?.footnotes)
        ? ((body as AnnotatePadDto).footnotes as DocFootnote[])
        : [];
    return footnoteDiffRows(notesOf(conflict.local), notesOf(conflict.server));
  }, [conflict]);

  const setVerdict = (side: "local" | "server", verdict: Verdict) => {
    setPicks({}); // A whole-pane verdict resets any per-mark picks.
    setVerdicts((current) => {
      const otherSide = side === "local" ? "server" : "local";
      if (verdict === "reject") {
        // Rejecting one side keeps the other outright; rejecting both would
        // leave nothing, so that combination cannot be reached.
        return { ...current, [side]: "reject", [otherSide]: "keep" } as typeof current;
      }
      return { ...current, [side]: verdict } as typeof current;
    });
  };

  /** A pane's marks survive by default only when that pane was kept. */
  const defaultKeep = (side: "local" | "server"): boolean => verdicts[side] === "keep";

  const effectiveKeep = (id: string, side: "local" | "server"): boolean =>
    picks[id]?.[side] ?? defaultKeep(side);

  /** Tap cycle per mark: follow the pane → keep it → drop it → pane again. */
  const toggleNote = (side: "local" | "server", id: string) => {
    setPicks((current) => ({
      ...current,
      [id]: { ...current[id], [side]: nextPick(current[id]?.[side]) },
    }));
  };

  const valid =
    Boolean(conflict) &&
    (verdicts.local === "keep" || verdicts.server === "keep") &&
    rows.every(
      (row) => effectiveKeep(row.id, "local") || effectiveKeep(row.id, "server"),
    );

  const onResolveTap = () => {
    if (!conflict || !valid) return;
    // Any explicit per-mark pick — or both panes kept — makes this a merge;
    // otherwise it is whichever whole pane was kept.
    const explicit = Object.values(picks).some(
      (pick) => pick.local !== undefined || pick.server !== undefined,
    );
    if (explicit || (verdicts.local === "keep" && verdicts.server === "keep")) {
      if (conflict.kind !== "annotate") {
        // Whiteboards have no footnotes to merge; left pane wins the fields.
        onResolve({ pick: "local" });
        return;
      }
      // Feed the merge the fully-resolved choice for every mark so the
      // outcome does not depend on how the defaults were derived.
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
      onResolve({ pick: "merged", footnotes: merged });
      return;
    }
    onResolve({ pick: verdicts.server === "keep" ? "server" : "local" });
  };

  if (!conflict) return null;

  const renderPane = (side: "local" | "server") => {
    const body = side === "local" ? conflict.local : conflict.server;
    const at = updatedAtOf(body);
    const verdict = verdicts[side];
    return (
      <section className="lc-hub-conflict-pane" data-side={side} data-verdict={verdict}>
        <header className="lc-hub-conflict-pane-head">
          <span className="lc-hub-conflict-tab">{side === "local" ? "Local" : "Server"}</span>
          <span className="lc-hub-conflict-pane-updated">
            {at != null ? new Date(at).toLocaleString() : ""}
          </span>
          <button
            type="button"
            aria-pressed={verdict === "keep"}
            aria-label={`Keep the ${side} copy entirely`}
            title={verdict === "keep" ? "This whole copy is kept" : "✓ keeps this entire pane"}
            className={
              verdict === "keep"
                ? "lc-doc-confirm-btn lc-doc-confirm-yes"
                : "lc-doc-confirm-btn"
            }
            onClick={() => setVerdict(side, verdict === "keep" ? "undecided" : "keep")}
          >
            ✓
          </button>
          <button
            type="button"
            aria-pressed={verdict === "reject"}
            aria-label={`Reject the ${side} copy`}
            title={verdict === "reject" ? "Rejected — tap to reconsider" : "✕ throws this copy away"}
            className={verdict === "reject" ? "lc-doc-confirm-btn lc-doc-confirm-no" : "lc-doc-confirm-btn"}
            onClick={() => setVerdict(side, verdict === "reject" ? "undecided" : "reject")}
          >
            ✕
          </button>
        </header>
        <div className="lc-hub-conflict-pane-body">
          {rows.map((row) => (
            <NoteRow
              key={`${side}:${row.id}`}
              note={side === "local" ? row.local : row.server}
              side={side}
              sameId={row.sameId}
              differs={row.differs}
              kept={effectiveKeep(row.id, side)}
              onToggle={toggleNote}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="lc-hub-conflict" role="dialog" aria-modal="true" aria-label="Sync conflict">
      <header className="lc-hub-conflict-head">
        <strong>Both copies changed — {nameOf(conflict)}</strong>
        <span>{conflict.detail}. Choose what stays; nothing has been written yet.</span>
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
              ? "Ready."
              : "Mark each pane ✓ or ✕; every note needs a home."}
        </span>
        <button
          type="button"
          disabled={!valid || busy}
          className="lc-hub-conflict-resolve"
          onClick={onResolveTap}
        >
          Keep selection
        </button>
      </footer>
    </div>
  );
}
