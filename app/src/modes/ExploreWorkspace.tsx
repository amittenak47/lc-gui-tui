/**
 * The atlas — every workspace, and the links between them.
 *
 * Not a `Board`. No Excalidraw, no ink, no pdf.js: this is a view *of* the
 * other pads, so mounting a canvas engine to draw it would put a third heavy
 * surface into the mount budget for something that is a few hundred circles
 * and lines. Plain SVG, laid out here.
 *
 * Nodes cluster by kind rather than floating in one anonymous cloud, because
 * the first question anyone asks of a graph like this is "where are my notes",
 * not "what is most connected". Isolated nodes still appear — a note written
 * five minutes ago has no edges yet and is exactly what its author is looking
 * for.
 *
 * Selecting is not opening. A tap parks a spec card beside the node, the same
 * card the ink wheel uses to explain a nib; opening is an explicit choice on
 * it. Reading the graph and rearranging your tabs are different activities.
 */

import { useEffect, useMemo, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import {
  isUnresolved,
  listEdges,
  nodeKey,
  sameNode,
  type Edge,
  type EdgeKind,
  type NodeRef,
  type NodeType,
} from "../util/noteLinks";

export interface ExploreWorkspaceProps {
  /** Every node the libraries know about, whether or not it has edges. */
  nodes: readonly NodeRef[];
  /** The node the reader is looking at in another pane, if any. */
  here?: NodeRef | null;
  onOpen: (node: NodeRef) => void;
  onOpenInNewTab: (node: NodeRef) => void;
  /** Practice is one tab, so its "open in new tab" is refused, not hidden. */
  canOpenInNewTab: (node: NodeRef) => boolean;
}

const CLUSTERS: ReadonlyArray<{ type: NodeType; label: string }> = [
  { type: "annotate", label: "Notes & documents" },
  { type: "whiteboard", label: "Whiteboards" },
  { type: "practice", label: "Practice" },
  { type: "web", label: "Web" },
  { type: "thread", label: "Threads" },
];

const EDGE_LABEL: Record<EdgeKind, string> = {
  wiki: "typed link",
  picker: "linked",
  "footnote-thread": "thread on a mark",
  "footnote-url": "saved URL",
  ink: "drawn link",
};

const VIEW = { w: 1000, h: 640 };

export interface PlacedNode {
  node: NodeRef;
  x: number;
  y: number;
}

/**
 * Lay each populated cluster out as a ring, on a grid of the clusters present.
 *
 * Fixed per-kind centres were the obvious thing and the wrong one: with only
 * notes and whiteboards in the library — which is most libraries — both sat in
 * the upper band and two thirds of the canvas stayed empty. The grid is over
 * the kinds that *exist*, so the atlas fills whatever it is given.
 *
 * Deterministic — no force simulation, no randomness. A graph that settles
 * somewhere different every time it opens cannot be learned, and the reader's
 * memory of "my notes are on the left" is worth more than an optimal
 * edge-crossing count. Cluster order is fixed, so a kind only moves when a
 * different kind appears or empties.
 */
export function layoutNodes(nodes: readonly NodeRef[]): PlacedNode[] {
  const populated = CLUSTERS.filter(({ type }) => nodes.some((node) => node.type === type));
  if (populated.length === 0) return [];

  const cols = Math.ceil(Math.sqrt(populated.length));
  const rows = Math.ceil(populated.length / cols);
  const out: PlacedNode[] = [];

  populated.forEach((cluster, cell) => {
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    // Centre of this cell, so a lone cluster lands in the middle of the canvas
    // rather than in the corner of an invisible grid.
    const cx = ((col + 0.5) / cols) * VIEW.w;
    const cy = ((row + 0.5) / rows) * VIEW.h;
    const members = nodes.filter((node) => node.type === cluster.type);
    if (members.length === 1) {
      out.push({ node: members[0]!, x: cx, y: cy });
      return;
    }
    // Radius grows with the count, capped to the cell so neighbours do not
    // collide, and squashed vertically to leave room for the labels.
    const radius = Math.min(
      Math.min(VIEW.w / cols, VIEW.h / rows) * 0.32,
      46 + members.length * 7,
    );
    members.forEach((node, index) => {
      const angle = (index / members.length) * Math.PI * 2 - Math.PI / 2;
      out.push({
        node,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * 0.82,
      });
    });
  });
  return out;
}

/** Where a populated cluster's label sits — above its ring. */
export function clusterLabelPoints(
  nodes: readonly NodeRef[],
): Array<{ type: NodeType; label: string; x: number; y: number }> {
  const placed = layoutNodes(nodes);
  return CLUSTERS.flatMap((cluster) => {
    const members = placed.filter((entry) => entry.node.type === cluster.type);
    if (members.length === 0) return [];
    const xs = members.map((entry) => entry.x);
    const top = Math.min(...members.map((entry) => entry.y));
    return [
      {
        type: cluster.type,
        label: cluster.label,
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: top - 26,
      },
    ];
  });
}

export function ExploreWorkspace({
  nodes,
  here = null,
  onOpen,
  onOpenInNewTab,
  canOpenInNewTab,
}: ExploreWorkspaceProps) {
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [filter, setFilter] = useState<NodeType | "all">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void listEdges()
      .then((rows) => {
        if (live) setEdges(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return nodes.filter((node) => {
      if (filter !== "all" && node.type !== filter) return false;
      if (!wanted) return true;
      return (node.title ?? node.id).toLowerCase().includes(wanted);
    });
  }, [filter, nodes, query]);

  const placed = useMemo(() => layoutNodes(shown), [shown]);
  const at = useMemo(() => {
    const map = new Map<string, PlacedNode>();
    for (const entry of placed) map.set(nodeKey(entry.node), entry);
    return map;
  }, [placed]);

  // Only edges with both ends on screen — a line to nothing is worse than a
  // missing line, because it looks like the node is somewhere off-view.
  const drawn = useMemo(
    () =>
      edges.flatMap((edge) => {
        const from = at.get(nodeKey(edge.from));
        const to = at.get(nodeKey(edge.to));
        return from && to ? [{ edge, from, to }] : [];
      }),
    [at, edges],
  );

  const neighbourKeys = useMemo(() => {
    if (!selected) return new Set<string>();
    const keys = new Set<string>();
    for (const { edge } of drawn) {
      if (sameNode(edge.from, selected)) keys.add(nodeKey(edge.to));
      else if (sameNode(edge.to, selected)) keys.add(nodeKey(edge.from));
    }
    return keys;
  }, [drawn, selected]);

  const selectedEdges = useMemo(
    () =>
      selected
        ? drawn.filter(
            ({ edge }) => sameNode(edge.from, selected) || sameNode(edge.to, selected),
          )
        : [],
    [drawn, selected],
  );

  return (
    <div className="lc-explore">
      <div className="lc-explore-chrome">
        <div className="lc-explore-filters" role="group" aria-label="Filter by kind">
          <button
            type="button"
            className={filter === "all" ? "lc-explore-chip is-active" : "lc-explore-chip"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          {CLUSTERS.map((cluster) => (
            <button
              key={cluster.type}
              type="button"
              className={filter === cluster.type ? "lc-explore-chip is-active" : "lc-explore-chip"}
              aria-pressed={filter === cluster.type}
              onClick={() => setFilter(cluster.type)}
            >
              {cluster.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="lc-explore-search"
          value={query}
          placeholder="Find by title"
          aria-label="Find a workspace by title"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {placed.length === 0 ? (
        <p className="lc-explore-empty">
          {nodes.length === 0
            ? "Nothing in the library yet. Write a note, or open a document to annotate."
            : "Nothing matches that filter."}
        </p>
      ) : (
        <svg
          className="lc-explore-canvas"
          viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="Workspace graph"
        >
          {clusterLabelPoints(shown).map((spot) => (
            <text
              key={spot.type}
              className="lc-explore-cluster-label"
              x={spot.x}
              y={spot.y}
              textAnchor="middle"
            >
              {spot.label}
            </text>
          ))}

          {drawn.map(({ edge, from, to }) => {
            const touched =
              !selected ||
              sameNode(edge.from, selected) ||
              sameNode(edge.to, selected);
            return (
              <line
                key={edge.id}
                className={`lc-explore-edge is-${edge.kind}${touched ? "" : " is-dim"}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}

          {placed.map((entry) => {
            const key = nodeKey(entry.node);
            const isSelected = selected ? sameNode(entry.node, selected) : false;
            const dim = Boolean(selected) && !isSelected && !neighbourKeys.has(key);
            const live = here ? sameNode(entry.node, here) : false;
            return (
              <g
                key={key}
                className={[
                  "lc-explore-node",
                  `is-${entry.node.type}`,
                  isSelected ? "is-selected" : "",
                  dim ? "is-dim" : "",
                  live ? "is-here" : "",
                  isUnresolved(entry.node) ? "is-missing" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                transform={`translate(${entry.x} ${entry.y})`}
              >
                <circle
                  r={live ? 13 : 10}
                  role="button"
                  tabIndex={0}
                  aria-label={`${entry.node.title ?? entry.node.id} — ${entry.node.type}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelected(isSelected ? null : entry.node)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelected(isSelected ? null : entry.node);
                  }}
                />
                <text className="lc-explore-node-label" y={26} textAnchor="middle">
                  {truncate(entry.node.title ?? entry.node.id)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {selected && (
        <div className="lc-explore-card lc-ink-wheel-card" role="dialog" aria-label="Workspace">
          <header className="lc-explore-card-head">
            <strong>{selected.title ?? selected.id}</strong>
            <span className="lc-muted">
              {(CLUSTERS.find((cluster) => cluster.type === selected.type)?.label ?? selected.type)
                .toUpperCase()}
              {isUnresolved(selected) ? " · MISSING" : ""}
            </span>
          </header>

          <dl className="lc-explore-spec">
            <dt>Links</dt>
            <dd>{selectedEdges.length}</dd>
            {selected.parent && (
              <>
                <dt>On</dt>
                <dd>{selected.parent.id}</dd>
              </>
            )}
          </dl>

          {selectedEdges.length > 0 && (
            <ul className="lc-explore-neighbours">
              {selectedEdges.map(({ edge }) => {
                const other = sameNode(edge.from, selected) ? edge.to : edge.from;
                return (
                  <li key={edge.id}>
                    <button
                      type="button"
                      className="lc-agent-scope-option"
                      // Hop, not open: selecting a neighbour walks the graph
                      // while staying on the atlas.
                      onClick={() => setSelected(other)}
                    >
                      <strong>{other.title ?? other.id}</strong>
                      <span className="lc-muted">{EDGE_LABEL[edge.kind]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="lc-explore-card-actions">
            {isUnresolved(selected) ? (
              <p className="lc-muted">
                A link points here, but nothing by that name exists yet.
              </p>
            ) : (
              <>
                <HoldButton
                  label="Open"
                  className="lc-hold-choice"
                  onConfirm={() => onOpen(selected)}
                >
                  <strong>Open</strong>
                  <span className="lc-muted">Focus its tab, or make one.</span>
                </HoldButton>
                <HoldButton
                  label="Open in new tab"
                  className="lc-hold-choice"
                  disabled={!canOpenInNewTab(selected)}
                  onConfirm={() => onOpenInNewTab(selected)}
                >
                  <strong>Open in new tab</strong>
                  <span className="lc-muted">
                    {canOpenInNewTab(selected)
                      ? "A second chip, beside this atlas."
                      : "Practice is one tab."}
                  </span>
                </HoldButton>
              </>
            )}
            <button type="button" className="lc-secondary" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(text: string, max = 18): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
