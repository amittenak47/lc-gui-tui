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
  sagOf,
  settle,
  step,
  type Body,
  type Link,
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
  /** Edges by id, for the paint loop, which must not depend on React state. */
  const edgeIndexRef = useRef(new Map<string, Edge>());
  /** The same edges as springs, for the simulation. */
  const linksRef = useRef<Link[]>([]);
  const bodiesRef = useRef<Body[]>([]);
  const nodeElsRef = useRef(new Map<string, HTMLElement>());
  const edgeElsRef = useRef(new Map<string, SVGPathElement>());
  /** The blurred copy of each edge, drawn under its core. */
  const glowElsRef = useRef(new Map<string, SVGPathElement>());
  const boxRef = useRef({ w: 0, h: 0 });
  const clusteredRef = useRef(clustered);
  clusteredRef.current = clustered;
  /** So the seeding effect can repaint without depending on the painter. */
  const paintRef = useRef<() => void>(() => {});

  useEffect(() => {
    edgeIndexRef.current = new Map(edges.map((edge) => [edge.id, edge]));
    linksRef.current = edges.map((edge) => ({
      a: nodeKey(edge.from),
      b: nodeKey(edge.to),
    }));
  }, [edges]);

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
        240,
        linksRef.current,
      );
      paintRef.current();
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
      const first = boxRef.current.w === 0 || boxRef.current.h === 0;
      boxRef.current = { w: box.width, h: box.height };
      /*
       * Re-settle the first time the box is real.
       *
       * The bodies are built before this effect runs, so their first settle
       * used a guessed aspect. On a wide pane that guess is wrong enough that
       * cards start overlapping and the reader watches them shuffle apart for
       * a second. Settling again with the measured box means the atlas is
       * already at rest on the frame it appears.
       */
      if (first && box.width > 0 && box.height > 0) {
        settle(
          bodiesRef.current,
          clusterCentres(bodiesRef.current.map((body) => body.node.type)),
          clusteredRef.current,
          box.width / box.height,
          240,
          linksRef.current,
        );
        paint();
      }
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
      // `translate3d` rather than `left`/`top`: this runs every frame for every
      // node, and only the transform stays off the layout path.
      if (el) el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
    const aspect = h > 0 ? w / h : 1.6;
    for (const [id, line] of edgeElsRef.current) {
      const edge = edgeIndexRef.current.get(id);
      if (!edge) continue;
      const from = at.get(nodeKey(edge.from));
      const to = at.get(nodeKey(edge.to));
      if (!from || !to) continue;
      /*
       * A quadratic whose control point is pushed off the chord.
       *
       * How far is `sagOf`, which reads the spring's extension, so a slack
       * link hangs and a stretched one pulls straight. The side is seeded from
       * the edge id, or every link in a bundle would bow the same way and the
       * whole thing would look combed.
       */
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const pixels = Math.hypot(dx, dy) || 1;
      // Back into normalized, aspect-corrected units to ask about the spring.
      const normalized = Math.hypot((dx / Math.max(w, 1)) * aspect, dy / Math.max(h, 1));
      const bow = sagOf(normalized) * pixels * sideOf(id);
      const midX = (from.x + to.x) / 2 - (dy / pixels) * bow;
      const midY = (from.y + to.y) / 2 + (dx / pixels) * bow;
      const d = `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${midX.toFixed(1)} ${midY.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
      line.setAttribute("d", d);
      glowElsRef.current.get(id)?.setAttribute("d", d);
    }
  }, []);

  paintRef.current = paint;

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
        240,
        linksRef.current,
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
        links: linksRef.current,
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

  const select = (node: NodeRef, el: HTMLElement | null) => {
    setSheetFrom(el?.getBoundingClientRect() ?? null);
    setSelected(node);
  };

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
          <>
            {/*
              Edges are SVG because they are geometry; nodes are HTML because
              they are cards. Trying to draw a card in SVG means reinventing
              border-radius, hairlines and type, and the result never quite
              matches the ones the rest of the app already draws.
            */}
            <svg className="lc-explore-beams" aria-hidden>
              <defs>
                {/*
                  The bloom. One blur, applied to a coloured copy of every edge,
                  with a thinner bright core drawn over it unblurred. Colour
                  spills a little, the core stays sharp, and the line still
                  reads as a line rather than as a highlighter stroke.
                */}
                <filter id="lc-saber-glow" x="-40%" y="-40%" width="180%" height="180%">
                  <feGaussianBlur stdDeviation="2.2" />
                </filter>
              </defs>

              <g className="lc-explore-beam-glow" filter="url(#lc-saber-glow)">
                {drawnEdges.map((edge) => {
                  const touched =
                    !selected || sameNode(edge.from, selected) || sameNode(edge.to, selected);
                  return (
                    <path
                      key={edge.id}
                      ref={(el) => {
                        if (el) glowElsRef.current.set(edge.id, el);
                        else glowElsRef.current.delete(edge.id);
                      }}
                      className={`lc-explore-beam is-${edge.kind}${touched ? "" : " is-dim"}`}
                    />
                  );
                })}
              </g>

              <g className="lc-explore-beam-core">
                {drawnEdges.map((edge) => {
                  const touched =
                    !selected || sameNode(edge.from, selected) || sameNode(edge.to, selected);
                  return (
                    <path
                      key={edge.id}
                      ref={(el) => {
                        if (el) edgeElsRef.current.set(edge.id, el);
                        else edgeElsRef.current.delete(edge.id);
                      }}
                      className={`lc-explore-beam is-${edge.kind}${touched ? "" : " is-dim"}`}
                    />
                  );
                })}
              </g>
            </svg>

            {clustered &&
              labels.map((spot) => (
                <span
                  key={spot.type}
                  className="lc-explore-cluster-label"
                  style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
                >
                  {spot.label}
                </span>
              ))}

            <div className="lc-explore-nodes">
              {bodiesRef.current.map((body) => {
                const key = body.key;
                const isSelected = selected ? sameNode(body.node, selected) : false;
                const dim = Boolean(selected) && !isSelected && !neighbourKeys.has(key);
                const live = here ? sameNode(body.node, here) : false;
                return (
                  <button
                    key={key}
                    type="button"
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
                    aria-pressed={isSelected}
                    onClick={(event) => select(body.node, event.currentTarget)}
                  >
                    <span className="lc-explore-node-dot" />
                    <span className="lc-explore-node-label">
                      {truncate(body.node.title ?? body.node.id)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
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

/** Which way an edge bows. Seeded from its id so a bundle is not combed flat. */
function sideOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 1) === 0 ? 1 : -1;
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
