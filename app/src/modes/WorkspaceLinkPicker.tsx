/**
 * Pick another workspace to link this one to.
 *
 * The pen-free half of §5: typing `[[Title]]` belongs to Edit, which only
 * owned markdown has. Everything else — a PDF, a web capture, an imported
 * file — is annotated rather than written, and asking someone to type wiki
 * syntax with a stylus in their hand is asking the wrong question. So the
 * same edge is reachable as a list.
 *
 * Targets come from what the reader has actually been using: the open tabs and
 * the two libraries. Not a search over the whole corpus — a picker that needs
 * a query is a second problem to solve before the first one.
 */

import { useMemo, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import type { NodeRef, NodeType } from "../util/noteLinks";

export interface LinkTarget {
  node: NodeRef;
  /** What the row says under the title — "Whiteboard", "Practice", … */
  group: string;
}

export interface WorkspaceLinkPickerProps {
  /** What is being linked *from*, so it cannot be offered as a target. */
  fromTitle: string;
  targets: readonly LinkTarget[];
  onPick: (node: NodeRef) => void;
  onCancel: () => void;
}

const GROUP_ORDER = ["Open tabs", "Notes and documents", "Whiteboards", "Practice"];

export function groupLabel(type: NodeType): string {
  switch (type) {
    case "whiteboard":
      return "Whiteboards";
    case "practice":
      return "Practice";
    case "web":
      return "Web pages";
    case "thread":
      return "Threads";
    case "annotate":
      return "Notes and documents";
  }
}

export function WorkspaceLinkPicker({
  fromTitle,
  targets,
  onPick,
  onCancel,
}: WorkspaceLinkPickerProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    const matching = wanted
      ? targets.filter((target) => (target.node.title ?? "").toLowerCase().includes(wanted))
      : targets;
    const byGroup = new Map<string, LinkTarget[]>();
    for (const target of matching) {
      const list = byGroup.get(target.group);
      if (list) list.push(target);
      else byGroup.set(target.group, [target]);
    }
    return [...byGroup.entries()].sort(
      (a, b) => orderOf(a[0]) - orderOf(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [query, targets]);

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Link from ${fromTitle}`}
      >
        <div className="lc-settings-head">
          <h2>Link to…</h2>
          <p className="lc-muted">
            From “{fromTitle}”. The link is a pointer — nothing is copied, and the other side is
            not changed.
          </p>
        </div>
        <div className="lc-settings-body">
          {targets.length > 8 && (
            <label className="lc-md-new-title">
              <span className="lc-muted">Filter</span>
              <input
                type="text"
                value={query}
                placeholder="Type to narrow"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {groups.length === 0 ? (
            <p className="lc-muted">
              {targets.length === 0
                ? "Nothing else open or in the library yet."
                : "Nothing matches that."}
            </p>
          ) : (
            groups.map(([group, rows]) => (
              <div key={group} className="lc-settings-choice">
                <p className="lc-muted">{group}</p>
                {rows.map((row) => (
                  <HoldButton
                    key={`${row.node.type}:${row.node.id}`}
                    label={`Link to ${row.node.title ?? row.node.id}`}
                    className="lc-hold-choice"
                    onConfirm={() => onPick(row.node)}
                  >
                    <strong>{row.node.title ?? row.node.id}</strong>
                    <span className="lc-muted">{groupLabel(row.node.type)}</span>
                  </HoldButton>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function orderOf(group: string): number {
  const at = GROUP_ORDER.indexOf(group);
  return at === -1 ? GROUP_ORDER.length : at;
}
