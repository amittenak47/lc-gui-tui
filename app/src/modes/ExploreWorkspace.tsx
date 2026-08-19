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
import { createPortal } from "react-dom";

import { BackgroundPalette } from "../components/BackgroundPalette";
import { MorphBar } from "../components/MorphBar";
import { useShell } from "../shellContext";
import { NodeSheet, type NodeSheetNeighbour } from "./NodeSheet";
import {
  CLUSTERS,
  clusterCentres,
  clusterLabels,
  clusterSettled,
  makeBodies,
  sagOf,
  settle,
  step,
  EDGE_PAD,
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
  /** Tools join the board tray only while this tab is the one on screen. */
  active?: boolean;
  /** Parked Explore must not keep a portal in the board tray. */
  showing?: boolean;
  /** Wait for the board's tray slot rather than filling the shell slot. */
  embedInBoardTray?: boolean;
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
  active = true,
  showing = true,
  embedInBoardTray = false,
}: ExploreWorkspaceProps) {
  const { headerSlots } = useShell();
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [sheetFrom, setSheetFrom] = useState<DOMRect | null>(null);
  const [kinds, setKinds] = useState<NodeType[]>([]);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [clustered, setClustered] = useState(false);
  const [clusterReady, setClusterReady] = useState(false);
  const [frozenLabels, setFrozenLabels] = useState<
    Array<{ type: NodeType; label: string; x: number; y: number }>
  >([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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
  const clusterReadyRef = useRef(clustered);
  clusterReadyRef.current = clusterReady;
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [chromeHost, setChromeHost] = useState<HTMLElement | null>(null);
  const [inBoardStack, setInBoardStack] = useState(false);
  /** So the seeding effect can repaint without depending on the painter. */
  const paintRef = useRef<() => void>(() => {});
  const pinnedKeyRef = useRef<string | null>(null);
  const skipNodeClickRef = useRef(false);
  const dragNodeRef = useRef<{
    key: string;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

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
      if (kinds.length > 0 && !kinds.includes(node.type)) return false;
      if (!wanted) return true;
      return (node.title ?? node.id).toLowerCase().includes(wanted);
    });
  }, [kinds, nodes, query]);

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
      if (clustered) {
        const centres = clusterCentres(bodiesRef.current.map((body) => body.node.type));
        const aspect = box.h > 0 ? box.w / box.h : 1.6;
        if (clusterSettled(bodiesRef.current, centres, aspect)) {
          setFrozenLabels(clusterLabels(bodiesRef.current));
          setClusterReady(true);
        }
      }
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
      const centres = clusterCentres(bodiesRef.current.map((body) => body.node.type));
      const aspect = box.h > 0 ? box.w / box.h : 1.6;
      step(bodiesRef.current, centres, {
        clustered: clusteredRef.current,
        dt,
        time: elapsed,
        aspect,
        links: linksRef.current,
        pinnedKey: pinnedKeyRef.current,
      });
      paint();
      if (clusteredRef.current) {
        const ready = clusterSettled(bodiesRef.current, centres, aspect);
        if (ready && !clusterReadyRef.current) {
          clusterReadyRef.current = true;
          setFrozenLabels(clusterLabels(bodiesRef.current));
          setClusterReady(true);
        }
      }
      // Edges follow node identity, not every frame. Captions wait on settle.
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

  useEffect(() => {
    clusterReadyRef.current = false;
    setClusterReady(false);
  }, [clustered]);

  useEffect(() => {
    if (!filterOpen && !searchOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!chromeRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
        setSearchOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [filterOpen, searchOpen]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (active) return;
    setFilterOpen(false);
    setSearchOpen(false);
  }, [active]);

  useEffect(() => {
    if (!showing) {
      setChromeHost(null);
      setInBoardStack(false);
      return;
    }
    const find = () => {
      const slot = document.querySelector("[data-lc-explore-chrome]") as HTMLElement | null;
      if (slot) {
        setChromeHost(slot);
        setInBoardStack(true);
        return;
      }
      if (embedInBoardTray) {
        setChromeHost(null);
        setInBoardStack(false);
        return;
      }
      setChromeHost(headerSlots.boardChrome);
      setInBoardStack(false);
    };
    find();
    const root = headerSlots.boardChrome;
    if (!root) return;
    const observer = new MutationObserver(find);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [showing, embedInBoardTray, headerSlots.boardChrome]);

  const toggleKind = (type: NodeType) => {
    setKinds((was) => (was.includes(type) ? was.filter((row) => row !== type) : [...was, type]));
  };

  const toggleCluster = () => {
    if (clustered) {
      for (const body of bodiesRef.current) {
        body.parkedX = body.x;
        body.parkedY = body.y;
      }
      setClustered(false);
      return;
    }
    setClustered(true);
  };

  const labels = clustered && clusterReady ? frozenLabels : [];

  const counts = useMemo(() => {
    const out = new Map<NodeType, number>();
    for (const node of nodes) out.set(node.type, (out.get(node.type) ?? 0) + 1);
    return out;
  }, [nodes]);

  const select = (node: NodeRef, el: HTMLElement | null) => {
    setSheetFrom(el?.getBoundingClientRect() ?? null);
    setSelected(node);
  };

  const placeDragged = (key: string, clientX: number, clientY: number) => {
    const host = hostRef.current;
    const body = bodiesRef.current.find((entry) => entry.key === key);
    if (!host || !body) return;
    const box = host.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    body.x = Math.min(1 - EDGE_PAD, Math.max(EDGE_PAD, (clientX - box.left) / box.width));
    body.y = Math.min(1 - EDGE_PAD, Math.max(EDGE_PAD, (clientY - box.top) / box.height));
    body.vx = 0;
    body.vy = 0;
    paint();
  };

  const exploreTools = (
    <MorphBar
      active={active ? "tools" : "idle"}
      axis="height"
      className="lc-explore-chrome-morph"
    >
      <div data-morph-id="idle" />
      <div data-morph-id="tools">
        <div className="lc-explore-chrome-tools" ref={chromeRef}>
          <form
            className={searchOpen ? "lc-explore-search-morph is-open" : "lc-explore-search-morph"}
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(queryDraft.trim());
              setSearchOpen(false);
            }}
          >
            <input
              ref={searchInputRef}
              type="search"
              value={queryDraft}
              placeholder="Find by title"
              aria-label="Find a workspace by title"
              tabIndex={searchOpen ? 0 : -1}
              onChange={(event) => {
                setQueryDraft(event.target.value);
                setQuery(event.target.value);
              }}
            />
            {queryDraft ? (
              <button
                type="button"
                className="lc-explore-search-clear"
                aria-label="Clear the search"
                onClick={() => {
                  setQueryDraft("");
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                ×
              </button>
            ) : null}
            <button
              type={searchOpen ? "submit" : "button"}
              className="lc-lined-toggle lc-tip-target"
              aria-label={searchOpen ? "Search" : "Find a workspace"}
              data-tip={searchOpen ? "Search" : "Find"}
              data-tip-placement="top"
              onClick={() => {
                if (searchOpen) return;
                setFilterOpen(false);
                setSearchOpen(true);
              }}
            >
              <SearchIcon />
            </button>
          </form>

          <div className="lc-explore-filter">
            <button
              type="button"
              className={
                filterOpen || kinds.length > 0
                  ? "lc-lined-toggle lc-tip-target is-active"
                  : "lc-lined-toggle lc-tip-target"
              }
              aria-expanded={filterOpen}
              aria-label="Filter by kind"
              data-tip="Kinds"
              data-tip-placement="top"
              onClick={() => {
                setSearchOpen(false);
                setFilterOpen((on) => !on);
              }}
            >
              <FilterIcon />
            </button>
            {filterOpen ? (
              <div className="lc-explore-filter-pop" role="listbox" aria-label="Kinds" aria-multiselectable="true">
                <button
                  type="button"
                  role="option"
                  aria-selected={kinds.length === 0}
                  className={kinds.length === 0 ? "lc-explore-chip is-active" : "lc-explore-chip"}
                  onClick={() => setKinds([])}
                >
                  All
                  <span className="lc-explore-chip-count">{nodes.length}</span>
                </button>
                {CLUSTERS.filter((cluster) => (counts.get(cluster.type) ?? 0) > 0).map((cluster) => {
                  const on = kinds.includes(cluster.type);
                  return (
                    <button
                      key={cluster.type}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={on ? "lc-explore-chip is-active" : "lc-explore-chip"}
                      onClick={() => toggleKind(cluster.type)}
                    >
                      <span className="lc-explore-chip-dot" style={{ background: TINT[cluster.type] }} />
                      {cluster.label}
                      <span className="lc-explore-chip-count">{counts.get(cluster.type)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

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
            data-tip-placement="top"
            onClick={toggleCluster}
          >
            <ClusterIcon on={clustered} />
          </button>
        </div>
      </div>
    </MorphBar>
  );

  const exploreChrome = inBoardStack ? (
    exploreTools
  ) : (
    <div className="lc-map-controls lc-map-controls-paged">
      <div className="lc-map-chrome-right">
        <div className="lc-map-chrome-stack" role="toolbar" aria-label="Atlas view">
          {exploreTools}
          <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="lc-explore">
      <div className="lc-explore-stage" ref={hostRef}>
        {showing && chromeHost && (active || inBoardStack)
          ? createPortal(exploreChrome, chromeHost)
          : null}

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

            {labels.map((spot) => (
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
                    onContextMenu={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      dragNodeRef.current = {
                        key,
                        pointerId: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        moved: false,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const drag = dragNodeRef.current;
                      if (!drag || drag.pointerId !== event.pointerId || drag.key !== key) return;
                      const dx = event.clientX - drag.x;
                      const dy = event.clientY - drag.y;
                      if (!drag.moved && dx * dx + dy * dy < 100) return;
                      drag.moved = true;
                      skipNodeClickRef.current = true;
                      pinnedKeyRef.current = key;
                      placeDragged(key, event.clientX, event.clientY);
                    }}
                    onPointerUp={(event) => {
                      const drag = dragNodeRef.current;
                      if (!drag || drag.pointerId !== event.pointerId || drag.key !== key) return;
                      const body = bodiesRef.current.find((entry) => entry.key === key);
                      if (body && drag.moved) {
                        body.parkedX = body.x;
                        body.parkedY = body.y;
                      }
                      pinnedKeyRef.current = null;
                      dragNodeRef.current = null;
                    }}
                    onPointerCancel={() => {
                      if (dragNodeRef.current?.key !== key) return;
                      pinnedKeyRef.current = null;
                      dragNodeRef.current = null;
                      skipNodeClickRef.current = false;
                    }}
                    onClick={(event) => {
                      if (skipNodeClickRef.current) {
                        skipNodeClickRef.current = false;
                        return;
                      }
                      select(body.node, event.currentTarget);
                    }}
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
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
