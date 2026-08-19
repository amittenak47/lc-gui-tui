/**
 * The atlas: every workspace, and the links between them.
 *
 * Not a `Board`. No Excalidraw, no ink, no pdf.js. This is a view *of* the
 * other pads, so mounting a canvas engine to draw a few hundred circles would
 * put a third heavy surface into a mount budget that exists for boards.
 *
 * Three things shape the implementation:
 *
 * **The box is never known.** Explore can be half a split pane, and the sash
 * moves while you watch. So the simulation works in normalized 0..1 space and a
 * ResizeObserver supplies the pixel box at paint time. Nothing recomputes on
 * resize; the same normalized point just lands somewhere else.
 *
 * **Nodes drift.** Positions live in a ref and are written straight to the DOM
 * from a rAF loop. Putting them in React state would re-render the tree sixty
 * times a second to move some circles, which is the wrong tool. React owns what
 * exists; the loop owns where it is.
 *
 * **Selecting is not opening.** A tap parks a panel that morphs out of the node
 * you tapped, the same panel the ink wheel uses to explain a nib. Opening is an
 * explicit button on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BackgroundPalette } from "../components/BackgroundPalette";
import { NodeSheet, type NodeSheetNeighbour } from "./NodeSheet";
import {
  CLUSTERS,
  clusterCentres,
  clusterLabels,
  makeBodies,
  settle,
  step,
  type Body,
} from "./exploreLayout";
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
  themeId: string;
  onThemePick: (id: string) => void;
  onOpen: (node: NodeRef) => void;
  onOpenInNewTab: (node: NodeRef) => void;
  /** Practice is one tab, so its "open in new tab" is refused, not hidden. */
  canOpenInNewTab: (node: NodeRef) => boolean;
  onUnlink?: (edgeId: string) => void;
  onRename?: (node: NodeRef, title: string) => void;
}

const EDGE_LABEL: Record<EdgeKind, string> = {
  wiki: "typed link",
  picker: "linked",
  "footnote-thread": "thread on a mark",
  "footnote-url": "saved URL",
  ink: "drawn link",
};

const TINT: Record<NodeType, string> = {
  annotate: "var(--accent)",
  whiteboard: "color-mix(in srgb, var(--accent) 45%, var(--muted))",
  practice: "#4aa36a",
  web: "#d98b3a",
  thread: "#a78bfa",
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function truncate(text: string, max = 20): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function ExploreWorkspace({
  nodes,
  here = null,
  themeId,
  onThemePick,
  onOpen,
  onOpenInNewTab,
  canOpenInNewTab,
  onUnlink,
  onRename,
}: ExploreWorkspaceProps) {
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [sheetFrom, setSheetFrom] = useState<DOMRect | null>(null);
  const [filter, setFilter] = useState<NodeType | "all">("all");
  const [query, setQuery] = useState("");
  const [clustered, setClustered] = useState(false);
  /** Bumped when the loop wants the labels redrawn, which is not every frame. */
  const [labelTick, setLabelTick] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  const nodeElsRef = useRef(new Map<string, SVGGElement>());
  const edgeElsRef = useRef(new Map<string, SVGLineElement>());
  const boxRef = useRef({ w: 0, h: 0 });
  const clusteredRef = useRef(clustered);
  clusteredRef.current = clustered;

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

  const shownKeys = useMemo(() => shown.map(nodeKey).join("|"), [shown]);

  /*
   * Keep the simulation's bodies in step with what is on screen.
   *
   * Nodes that survive a filter change keep their position and momentum, so
   * narrowing the view nudges the map rather than throwing it in the air.
   */
  useEffect(() => {
    const existing = new Map(bodiesRef.current.map((body) => [body.key, body]));
    // Seeded as a set, so coverage is even, then survivors keep the position
    // and momentum they already had.
    const next = makeBodies(shown, nodeKey).map((body) => {
      const kept = existing.get(body.key);
      return kept ? { ...kept, node: body.node } : body;
    });
    const fresh = next.length !== bodiesRef.current.length || bodiesRef.current.length === 0;
    bodiesRef.current = next;
    if (fresh) {
      const box = boxRef.current;
      settle(
        next,
        clusterCentres(next.map((body) => body.node.type)),
        clusteredRef.current,
        box.h > 0 ? box.w / box.h : 1.6,
      );
    }
    setLabelTick((tick) => tick + 1);
    // `shown` is rebuilt each render; its identity is not the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKeys]);

  /*
   * The box, measured rather than assumed.
   *
   * A ResizeObserver rather than a window listener: the window does not change
   * size when a split sash moves, but this element does.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => {
      const box = host.getBoundingClientRect();
      boxRef.current = { w: box.width, h: box.height };
    };
    read();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /** Write the current positions to the DOM. Called from rAF and on resize. */
  const paint = useCallback(() => {
    const { w, h } = boxRef.current;
    if (w === 0 || h === 0) return;
    const at = new Map<string, { x: number; y: number }>();
    for (const body of bodiesRef.current) {
      const x = body.x * w;
      const y = body.y * h;
      at.set(body.key, { x, y });
      const el = nodeElsRef.current.get(body.key);
      if (el) el.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    }
    for (const [id, line] of edgeElsRef.current) {
      const edge = edges.find((row) => row.id === id);
      if (!edge) continue;
      const from = at.get(nodeKey(edge.from));
      const to = at.get(nodeKey(edge.to));
      if (!from || !to) continue;
      line.setAttribute("x1", from.x.toFixed(1));
      line.setAttribute("y1", from.y.toFixed(1));
      line.setAttribute("x2", to.x.toFixed(1));
      line.setAttribute("y2", to.y.toFixed(1));
    }
  }, [edges]);

  /*
   * The drift loop.
   *
   * Stops entirely for reduced motion, after one settle, because a page that
   * never stops moving is exactly what that setting is asking about.
   */
  useEffect(() => {
    if (prefersReducedMotion()) {
      const box = boxRef.current;
      settle(
        bodiesRef.current,
        clusterCentres(bodiesRef.current.map((body) => body.node.type)),
        clustered,
        box.h > 0 ? box.w / box.h : 1.6,
      );
      paint();
      setLabelTick((tick) => tick + 1);
      return;
    }
    let frame = 0;
    let last = performance.now();
    let elapsed = 0;
    let sinceLabels = 0;
    const tick = (now: number) => {
      // Clamp, or a backgrounded tab returns with a multi-second step and
      // throws every node into a wall.
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      elapsed += dt;
      sinceLabels += dt;
      const box = boxRef.current;
      step(bodiesRef.current, clusterCentres(bodiesRef.current.map((body) => body.node.type)), {
        clustered: clusteredRef.current,
        dt,
        time: elapsed,
        aspect: box.h > 0 ? box.w / box.h : 1.6,
      });
      paint();
      // Cluster captions follow their members, but at four frames a second:
      // they are text, and text that moves every frame is unreadable.
      if (sinceLabels > 0.25) {
        sinceLabels = 0;
        setLabelTick((value) => value + 1);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clustered, paint]);

  const drawnEdges = useMemo(() => {
    const present = new Set(bodiesRef.current.map((body) => body.key));
    // Only edges with both ends on screen. A line to nothing is worse than a
    // missing line, because it looks like the node is somewhere off-view.
    return edges.filter(
      (edge) => present.has(nodeKey(edge.from)) && present.has(nodeKey(edge.to)),
    );
  }, [edges, labelTick]);

  const neighboursOf = useCallback(
    (node: NodeRef): NodeSheetNeighbour[] =>
      edges
        .filter((edge) => sameNode(edge.from, node) || sameNode(edge.to, node))
        .map((edge) => ({
          edgeId: edge.id,
          node: sameNode(edge.from, node) ? edge.to : edge.from,
          kindLabel: EDGE_LABEL[edge.kind],
        })),
    [edges],
  );

  const neighbourKeys = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(neighboursOf(selected).map((row) => nodeKey(row.node)));
  }, [neighboursOf, selected]);

  const labels = useMemo(
    () => (clustered ? clusterLabels(bodiesRef.current) : []),
    [clustered, labelTick],
  );

  const counts = useMemo(() => {
    const out = new Map<NodeType, number>();
    for (const node of nodes) out.set(node.type, (out.get(node.type) ?? 0) + 1);
    return out;
  }, [nodes]);

  const select = (node: NodeRef, el: SVGGElement | null) => {
    setSheetFrom(el?.getBoundingClientRect() ?? null);
    setSelected(node);
  };

  const { w, h } = boxRef.current;

  return (
    <div className="lc-explore">
      <header className="lc-explore-bar">
        <div className="lc-explore-filters" role="tablist" aria-label="Filter by kind">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={filter === "all" ? "lc-explore-chip is-active" : "lc-explore-chip"}
            onClick={() => setFilter("all")}
          >
            All
            <span className="lc-explore-chip-count">{nodes.length}</span>
          </button>
          {CLUSTERS.filter((cluster) => (counts.get(cluster.type) ?? 0) > 0).map((cluster) => (
            <button
              key={cluster.type}
              type="button"
              role="tab"
              aria-selected={filter === cluster.type}
              className={
                filter === cluster.type ? "lc-explore-chip is-active" : "lc-explore-chip"
              }
              onClick={() => setFilter(cluster.type)}
            >
              <span className="lc-explore-chip-dot" style={{ background: TINT[cluster.type] }} />
              {cluster.label}
              <span className="lc-explore-chip-count">{counts.get(cluster.type)}</span>
            </button>
          ))}
        </div>

        <div className="lc-explore-search">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="Find by title"
            aria-label="Find a workspace by title"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="lc-explore-search-clear"
              aria-label="Clear the filter"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div className="lc-explore-stage" ref={hostRef}>
        {/*
          Same card and button shapes as the board's view controls, cut down to
          what an atlas has: no pen, no paper, no page to recentre.
        */}
        <div className="lc-explore-chrome">
          <div className="lc-map-chrome-stack" role="toolbar" aria-label="Atlas view">
            <button
              type="button"
              className={
                clustered
                  ? "lc-lined-toggle lc-tip-target is-active"
                  : "lc-lined-toggle lc-tip-target"
              }
              aria-pressed={clustered}
              aria-label={clustered ? "Let the nodes drift apart" : "Gather nodes by kind"}
              data-tip={clustered ? "Drifting" : "Cluster by kind"}
              data-tip-placement="left"
              onClick={() => setClustered((on) => !on)}
            >
              <ClusterIcon on={clustered} />
            </button>
            <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
          </div>
        </div>

        {bodiesRef.current.length === 0 ? (
          <p className="lc-explore-empty">
            {nodes.length === 0
              ? "Nothing in the library yet. Write a note, or open a document to annotate."
              : "Nothing matches that filter."}
          </p>
        ) : (
          <svg className="lc-explore-canvas" role="group" aria-label="Workspace graph">
            {labels.map((spot) => (
              <text
                key={spot.type}
                className="lc-explore-cluster-label"
                x={spot.x * w}
                y={spot.y * h - 34}
                textAnchor="middle"
              >
                {spot.label}
              </text>
            ))}

            {drawnEdges.map((edge) => {
              const touched =
                !selected || sameNode(edge.from, selected) || sameNode(edge.to, selected);
              return (
                <line
                  key={edge.id}
                  ref={(el) => {
                    if (el) edgeElsRef.current.set(edge.id, el);
                    else edgeElsRef.current.delete(edge.id);
                  }}
                  className={`lc-explore-edge is-${edge.kind}${touched ? "" : " is-dim"}`}
                />
              );
            })}

            {bodiesRef.current.map((body) => {
              const key = body.key;
              const isSelected = selected ? sameNode(body.node, selected) : false;
              const dim = Boolean(selected) && !isSelected && !neighbourKeys.has(key);
              const live = here ? sameNode(body.node, here) : false;
              return (
                <g
                  key={key}
                  ref={(el) => {
                    if (el) nodeElsRef.current.set(key, el);
                    else nodeElsRef.current.delete(key);
                  }}
                  className={[
                    "lc-explore-node",
                    `is-${body.node.type}`,
                    isSelected ? "is-selected" : "",
                    dim ? "is-dim" : "",
                    live ? "is-here" : "",
                    isUnresolved(body.node) ? "is-missing" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ ["--lc-node-tint" as string]: TINT[body.node.type] }}
                >
                  {live && <circle className="lc-explore-node-halo" r={18} />}
                  <circle
                    className="lc-explore-node-dot"
                    r={11}
                    role="button"
                    tabIndex={0}
                    aria-label={`${body.node.title ?? body.node.id}, ${body.node.type}`}
                    aria-pressed={isSelected}
                    onClick={(event) => select(body.node, event.currentTarget.ownerSVGElement ? (event.currentTarget.parentNode as SVGGElement) : null)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      select(body.node, event.currentTarget.parentNode as SVGGElement);
                    }}
                  />
                  <text className="lc-explore-node-label" y={28} textAnchor="middle">
                    {truncate(body.node.title ?? body.node.id)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {selected && (
        <NodeSheet
          node={selected}
          from={sheetFrom ?? { left: innerWidthSafe() / 2, top: 120, width: 0, height: 0 }}
          neighbours={neighboursOf(selected)}
          spec={specOf(selected, neighboursOf(selected).length)}
          tint={TINT[selected.type]}
          canOpenInNewTab={canOpenInNewTab(selected)}
          onOpen={() => {
            const node = selected;
            setSelected(null);
            onOpen(node);
          }}
          onOpenInNewTab={() => {
            const node = selected;
            setSelected(null);
            onOpenInNewTab(node);
          }}
          onHop={(node) => {
            const el = nodeElsRef.current.get(nodeKey(node));
            setSheetFrom(el?.getBoundingClientRect() ?? sheetFrom);
            setSelected(node);
          }}
          onUnlink={(edgeId) => {
            onUnlink?.(edgeId);
            setEdges((rows) => rows.filter((row) => row.id !== edgeId));
          }}
          onRename={onRename ? (title) => onRename(selected, title) : undefined}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function innerWidthSafe(): number {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}

function specOf(node: NodeRef, links: number): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const kind = CLUSTERS.find((cluster) => cluster.type === node.type)?.label ?? node.type;
  rows.push(["Kind", kind]);
  if (node.type === "practice") {
    const [dataset, ...rest] = node.id.split("/");
    rows.push(["Dataset", dataset ?? node.id]);
    rows.push(["Problem", rest.join("/") || node.id]);
  } else if (node.type === "web") {
    try {
      rows.push(["Host", new URL(node.id).host]);
    } catch {
      rows.push(["Address", node.id]);
    }
  } else if (node.parent) {
    rows.push(["On", node.parent.id]);
  }
  rows.push(["Links", String(links)]);
  return rows;
}

/** Four satellites, drawn loose or gathered. */
function ClusterIcon({ on = false }: { on?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {on ? (
        <>
          <circle cx="12" cy="12" r="2.2" />
          <circle cx="9.2" cy="8.6" r="1.5" />
          <circle cx="15" cy="9" r="1.5" />
          <circle cx="9.6" cy="15.4" r="1.5" />
          <circle cx="14.8" cy="15.2" r="1.5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="2.2" />
          <circle cx="4.8" cy="5.6" r="1.5" />
          <circle cx="19.2" cy="6.2" r="1.5" />
          <circle cx="5.2" cy="18.6" r="1.5" />
          <circle cx="19" cy="18" r="1.5" />
        </>
      )}
    </svg>
  );
}
