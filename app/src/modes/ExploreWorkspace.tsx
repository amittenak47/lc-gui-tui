/**
 * The atlas: every workspace, and the links between them.
 *
 * Not a `Board`. No Excalidraw, no ink, no pdf.js. This is a view *of* the
 * other pads. One WebGL surface batches the map; React owns the controls and
 * accessible node buttons, with HTML/SVG as a fallback if GPU drawing is lost.
 *
 * Three things shape the implementation:
 *
 * **The box is never known.** Explore can be half a split pane, and the sash
 * moves while you watch. So the simulation works in normalized 0..1 space and a
 * ResizeObserver supplies the pixel box at paint time. Nothing recomputes on
 * resize; the same normalized point just lands somewhere else.
 *
 * **Nodes drift.** Positions live in a ref and go straight to the renderer from
 * a rAF loop. React owns what exists; the loop owns where it is.
 *
 * **Selecting is not opening.** A tap parks a panel that morphs out of the node
 * you tapped, the same panel the ink wheel uses to explain a nib. Opening is an
 * explicit button on it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BackgroundPalette } from "../components/BackgroundPalette";
import { MorphBar } from "../components/MorphBar";
import { INK_DISPLAY_HZ_EVENT, loadInkMatchDisplay } from "../util/inkDisplayHzPref";
import { useShell } from "../shellContext";
import type { LcClient } from "../api/client";
import {stepEdgeBow,edgeBowControl,edgeBowPath,type EdgeBow} from "./exploreEdge";
import { createExploreWebGL, type BeamGeometry, type GraphNodePosition, type GraphNodeStyle, type ExploreWebGLRenderer } from "./exploreWebGL";
import { NodeSheet, type NodeSheetNeighbour } from "./NodeSheet";
import {
  CLUSTERS,
  clusterCentres,
  clusterLabels,
  clusterSettled,
  makeBodies,
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
  refreshKey?: number;
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
  /**
   * Searching inside documents, not just their titles.
   *
   * Explore is the home for it (§3b): every other Ask is asked with one
   * document open and is usually about that document. This view is already
   * about the whole shelf.
   */
  client?: LcClient;
  /** Open the document a passage came from, named by its content hash. */
  onOpenHash?: (hash: string) => void;
}

const EDGE_LABEL: Record<EdgeKind, string> = {
  wiki: "typed link",
  picker: "linked",
  "footnote-thread": "thread on a mark",
  "footnote-url": "saved URL",
  ink: "drawn link",
};

const TINT: Record<NodeType, string> = {
  annotate: "var(--lc-mode-annotate)",
  whiteboard: "var(--lc-mode-whiteboard)",
  practice: "var(--lc-mode-practice)",
  web: "var(--lc-mode-browse)",
  thread: "var(--lc-mode-explore)",
};

const KIND_SHORT: Record<NodeType, string> = {
  annotate: "Notes",
  whiteboard: "Boards",
  practice: "Practice",
  web: "Web",
  thread: "Threads",
};

/** Quiet dots stay small; a well-linked node reads larger. */
function nodeDiameter(links: number): number {
  return Math.round(11 + Math.min(15, Math.sqrt(Math.max(0, links)) * 4.5));
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/*
 * Without Match display, quiet drift saves work at about 20 fps. With it on,
 * the same simulation and painter follow every display callback.
 */
/**
 * Fastest node, in screen pixels per second, under which the map is only
 * drifting. In box widths (0.05) this was ~70 px/s on a desktop window, so a
 * node still settling after a drop ran at 20 fps and visibly juddered; under
 * 4 px/s, a 20 fps step is a fifth of a pixel and nobody can see it.
 */
const IDLE_SPEED_PX = 4;
/** Seconds it has to stay that slow before the loop drops its rate. */
const IDLE_AFTER = 0.6;
/** Wait before each idle frame's rAF; with vsync that lands near 20 fps. */
const IDLE_GAP_MS = 40;

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
  refreshKey = 0,
}: ExploreWorkspaceProps) {
  void onUnlink;
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
  const [searchOpen, setSearchOpen] = useState(false);
  /** Nodes a filter just hid, kept mounted long enough to fade out. */
  const [leaving, setLeaving] = useState<Body[]>([]);
  /** Bumped when the loop wants the labels redrawn, which is not every frame. */
  const [labelTick, setLabelTick] = useState(0);
  const [matchDisplay, setMatchDisplay] = useState(loadInkMatchDisplay);
  const [webglGraph, setWebglGraph] = useState(false);

  useEffect(() => {
    const changed = () => setMatchDisplay(loadInkMatchDisplay());
    window.addEventListener(INK_DISPLAY_HZ_EVENT, changed);
    return () => window.removeEventListener(INK_DISPLAY_HZ_EVENT, changed);
  }, []);

  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Edges by id, for the paint loop, which must not depend on React state. */
  const edgeIndexRef = useRef(new Map<string, Edge>());
  const edgeBowsRef = useRef(new Map<string,EdgeBow>());
  const edgeBoxRef = useRef("");
  /** The same edges as springs, for the simulation. */
  const linksRef = useRef<Link[]>([]);
  const bodiesRef = useRef<Body[]>([]);
  const filterMotionRef = useRef<{start:number;from:Map<string,Body>;to:Map<string,Body>}|null>(null);
  const rememberedRef = useRef(new Map<string,Body>());
  const leavingRef = useRef<Body[]>([]);
  const nodeElsRef = useRef(new Map<string, HTMLElement>());
  const nodePositionsRef = useRef(new WeakMap<HTMLElement, string>());
  const edgePathsRef = useRef(new WeakMap<SVGPathElement, string>());
  const edgeElsRef = useRef(new Map<string, SVGPathElement>());
  /** The wide faint copy of each edge, drawn under its core. */
  const glowElsRef = useRef(new Map<string, SVGPathElement>());
  const graphCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphRendererRef = useRef<ExploreWebGLRenderer | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const focusedNodeRef = useRef<string | null>(null);
  const boxRef = useRef({ w: 0, h: 0 });
  const clusteredRef = useRef(clustered);
  clusteredRef.current = clustered;
  const clusterReadyRef = useRef(clustered);
  clusterReadyRef.current = clusterReady;
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLFormElement | null>(null);
  const leaveStampRef = useRef(0);
  const [chromeHost, setChromeHost] = useState<HTMLElement | null>(null);
  const [inBoardStack, setInBoardStack] = useState(false);
  /** So the seeding effect can repaint without depending on the painter. */
  const paintRef = useRef<() => void>(() => {});
  const pinnedKeyRef = useRef<string | null>(null);
  /** The drift's clock, kept across a pause so it resumes where it left off. */
  const driftTimeRef = useRef(0);
  /** Back to full rate now, for changes the loop would only notice a frame late. */
  const wakeRef = useRef<() => void>(() => {});
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
    for(const id of edgeBowsRef.current.keys())if(!edgeIndexRef.current.has(id))edgeBowsRef.current.delete(id);
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
  }, [refreshKey]);

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
    for(const body of bodiesRef.current) rememberedRef.current.set(body.key,{...body});
    const knownKeys=new Set(nodes.map(nodeKey));
    for(const key of rememberedRef.current.keys()) if(!knownKeys.has(key)) rememberedRef.current.delete(key);
    const existing = rememberedRef.current;
    // Seeded as a set, so coverage is even, then survivors keep the position
    // and momentum they already had.
    const next = makeBodies(shown, nodeKey).map((body) => {
      const kept = existing.get(body.key);
      return kept ? { ...kept, node: body.node } : body;
    });
    const nextKeys = new Set(next.map((body) => body.key));
    const departed = [...new Map([...leavingRef.current,...bodiesRef.current].filter(body=>!nextKeys.has(body.key)).map(body=>[body.key,body])).values()];
    const first = existing.size === 0;
    bodiesRef.current = next;
    const stamp = (leaveStampRef.current += 1);
    leavingRef.current=departed;
    setLeaving(departed);
    if (departed.length > 0) {
      window.setTimeout(() => {
        if (leaveStampRef.current === stamp) {leavingRef.current=[];setLeaving([]);}
      }, prefersReducedMotion() ? 0 : 340);
    }
    const box = boxRef.current;
    const targets=next.map(body=>({...body}));
    settle(targets,clusterCentres(targets.map(body=>body.node.type)),clusteredRef.current,
      box.h>0 ? box.w/box.h : 1.6,Math.max(8,Math.min(240,Math.floor(24000/Math.max(1,targets.length*targets.length)))),linksRef.current);
    if(first || prefersReducedMotion()) {
      bodiesRef.current=targets;filterMotionRef.current=null;
    } else {
      filterMotionRef.current={start:performance.now(),from:new Map(next.map(body=>[body.key,{...body}])),to:new Map(targets.map(body=>[body.key,body]))};
    }
    paintRef.current();
    wakeRef.current();
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
      wakeRef.current();
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
  const disableWebGL = useCallback(() => {
    graphRendererRef.current?.dispose();
    graphRendererRef.current=null;
    setWebglGraph(false);
  },[]);

  const paint = useCallback(() => {
    const { w, h } = boxRef.current;
    if (w === 0 || h === 0) return;
    const at = new Map<string, { x: number; y: number; vx:number; vy:number }>();
    const renderer=graphRendererRef.current;
    const positions:GraphNodePosition[]=[];
    for (const body of bodiesRef.current) {
      const x = body.x * w;
      const y = body.y * h;
      at.set(body.key, { x, y, vx:body.vx*w, vy:body.vy*h });
      if(renderer){positions.push({id:body.key,x,y});continue;}
      const el = nodeElsRef.current.get(body.key);
      // `translate3d` rather than `left`/`top`: this runs every frame for every
      // node, and only the transform stays off the layout path.
      const transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translate(-50%, -50%)`;
      if (el && nodePositionsRef.current.get(el) !== transform) {
        el.style.transform = transform;
        nodePositionsRef.current.set(el, transform);
      }
    }
    for(const body of leavingRef.current) if(!at.has(body.key)) {
      at.set(body.key,{x:body.x*w,y:body.y*h,vx:0,vy:0});
      if(renderer)positions.push({id:body.key,x:body.x*w,y:body.y*h});
    }
    const boxKey=`${w}:${h}`;
    if(edgeBoxRef.current!==boxKey){edgeBowsRef.current.clear();edgeBoxRef.current=boxKey;}
    const reduced=prefersReducedMotion(),now=performance.now(),edgeTime=now/1000;
    const geometry:BeamGeometry[]=[];
    for(const id of edgeBowsRef.current.keys())if(!edgeElsRef.current.has(id))edgeBowsRef.current.delete(id);
    for (const [id, line] of edgeElsRef.current) {
      const edge = edgeIndexRef.current.get(id);
      if (!edge) continue;
      const from = at.get(nodeKey(edge.from));
      const to = at.get(nodeKey(edge.to));
      if (!from || !to) continue;
      const bow=stepEdgeBow(from,to,edgeBowsRef.current.get(id),edgeTime,reduced);
      edgeBowsRef.current.set(id,bow);
      if(renderer){
        geometry.push({id,from,to,control:edgeBowControl(from,to,bow)});
        continue;
      }
      const d=edgeBowPath(from,to,bow);
      for (const path of [line, glowElsRef.current.get(id)]) {
        if (path && edgePathsRef.current.get(path) !== d) {
          path.setAttribute("d", d);
          edgePathsRef.current.set(path, d);
        }
      }
    }
    if(renderer){
      try {
        // Match the native button's :active stacking while a node is held.
        const dragKey=dragNodeRef.current?.key;
        if(dragKey){
          const index=positions.findIndex(position=>position.id===dragKey);
          if(index>=0)positions.push(...positions.splice(index,1));
        }
        renderer.setInteraction(hoveredNodeRef.current,focusedNodeRef.current);
        renderer.setReducedMotion(reduced,now);
        renderer.paint(positions,geometry,w,h,window.devicePixelRatio,now);
      }catch(cause){
        console.warn("Explore GPU drawing failed; using HTML/SVG",cause);
        disableWebGL();paintRef.current();
      }
    }
  }, [disableWebGL]);

  paintRef.current = paint;

  /*
   * The drift loop.
   *
   * Stops entirely for reduced motion, after one settle, because a page that
   * never stops moving is exactly what that setting is asking about. Parked
   * behind another tab it stays mounted, and nothing it moves is seen.
   */
  useEffect(() => {
    if (!showing) return;
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
    let timer = 0;
    let last = performance.now();
    let sinceLabels = 0;
    let quietFor = 0;
    let idle = false;
    let activeDt = 1 / 60;
    const pressed = new Set<number>();
    const labelsOf = () => bodiesRef.current.map((body) => `${body.key}\u0000${body.node.title ?? ""}`).join("\u0001");
    let labelsDrawn = labelsOf();
    const tick = (now: number) => {
      const gap = (now - last) / 1000;
      last = now;
      // Clamp, or a backgrounded tab returns with a multi-second step and
      // throws every node into a wall.
      const reducedRate = idle && !matchDisplay;
      const dt = reducedRate ? activeDt : Math.min(gap, 1 / 20);
      const steps = reducedRate ? Math.min(6, Math.max(1, Math.round(gap / activeDt))) : 1;
      if (!reducedRate) activeDt += (dt - activeDt) * 0.1;
      sinceLabels += dt * steps;
      const box = boxRef.current;
      const centres = clusterCentres(bodiesRef.current.map((body) => body.node.type));
      const aspect = box.h > 0 ? box.w / box.h : 1.6;
      const motion=filterMotionRef.current;
      if(motion && !pinnedKeyRef.current) {
        const t=Math.min(1,(now-motion.start)/360), eased=1-Math.pow(1-t,3);
        for(const body of bodiesRef.current){
          const from=motion.from.get(body.key),to=motion.to.get(body.key);if(!from||!to)continue;
          body.x=from.x+(to.x-from.x)*eased;body.y=from.y+(to.y-from.y)*eased;
          body.vx=to.vx;body.vy=to.vy;
        }
        if(t===1)filterMotionRef.current=null;
      } else {
        filterMotionRef.current=null;
        for (let i = 0; i < steps; i++) {
          step(bodiesRef.current, centres, {clustered:clusteredRef.current,dt,time:(driftTimeRef.current += dt),aspect,
            links:linksRef.current,pinnedKey:pinnedKeyRef.current});
        }
      }
      paint();
      if (clusteredRef.current) {
        const ready = clusterSettled(bodiesRef.current, centres, aspect);
        if (ready && !clusterReadyRef.current) {
          clusterReadyRef.current = true;
          setFrozenLabels(clusterLabels(bodiesRef.current));
          setClusterReady(true);
        }
      }
      // Edges and captions follow node identity, not position, so React only
      // hears about it when a body or its title changed.
      if (sinceLabels > 0.25) {
        sinceLabels = 0;
        const labels = labelsOf();
        if (labels !== labelsDrawn) {
          labelsDrawn = labels;
          setLabelTick((value) => value + 1);
        }
      }
      const busy = pressed.size > 0 || pinnedKeyRef.current !== null || filterMotionRef.current !== null;
      let fastest = 0;
      for (const body of bodiesRef.current) fastest = Math.max(fastest, Math.hypot(body.vx * box.w, body.vy * box.h));
      quietFor = busy || fastest >= IDLE_SPEED_PX ? 0 : quietFor + dt * steps;
      idle = quietFor >= IDLE_AFTER;
      if (idle && !matchDisplay) {
        timer = window.setTimeout(() => {
          timer = 0;
          frame = requestAnimationFrame(tick);
        }, IDLE_GAP_MS);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    wakeRef.current = () => {
      quietFor = 0;
      if (!timer) return;
      window.clearTimeout(timer);
      timer = 0;
      frame = requestAnimationFrame(tick);
    };
    const host = hostRef.current;
    const onDown = (event: PointerEvent) => {
      pressed.add(event.pointerId);
      wakeRef.current();
    };
    const onUp = (event: PointerEvent) => pressed.delete(event.pointerId);
    host?.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      wakeRef.current = () => {};
      host?.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [clustered, paint, showing, matchDisplay]);

  const degree = useMemo(() => {
    const out = new Map<string, number>();
    for (const edge of edges) {
      const from = nodeKey(edge.from);
      const to = nodeKey(edge.to);
      out.set(from, (out.get(from) ?? 0) + 1);
      out.set(to, (out.get(to) ?? 0) + 1);
    }
    return out;
  }, [edges]);

  const drawnEdges = useMemo(() => {
    const present = new Set([
      ...bodiesRef.current.map((body) => body.key),
      ...leaving.map((body) => body.key),
    ]);
    // Only edges with both ends on screen. A line to nothing is worse than a
    // missing line, because it looks like the node is somewhere off-view.
    return edges.filter(
      (edge) => present.has(nodeKey(edge.from)) && present.has(nodeKey(edge.to)),
    );
  }, [edges, labelTick, leaving]);

  const neighboursOf = useCallback(
    (node: NodeRef): NodeSheetNeighbour[] =>
      edges
        .filter((edge) => sameNode(edge.from, node) || sameNode(edge.to, node))
        .map((edge) => ({
          edgeId: edge.id,
          node: (()=>{const target=sameNode(edge.from,node)?edge.to:edge.from;return nodes.find(candidate=>sameNode(candidate,target))??target;})(),
          kindLabel: EDGE_LABEL[edge.kind],
        })),
    [edges,nodes],
  );

  const neighbourKeys = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(neighboursOf(selected).map((row) => nodeKey(row.node)));
  }, [neighboursOf, selected]);

  const leavingKeys = useMemo(() => new Set(leaving.map((body) => body.key)), [leaving]);
  const edgeFading = (edge: Edge) => leavingKeys.has(nodeKey(edge.from)) || leavingKeys.has(nodeKey(edge.to));
  const hasGraph=bodiesRef.current.length>0 || leaving.length>0;

  useLayoutEffect(() => {
    const canvas=graphCanvasRef.current;
    if(!canvas){setWebglGraph(false);return;}
    const restore=()=>{
      graphRendererRef.current?.dispose();
      graphRendererRef.current=createExploreWebGL(canvas);
      setWebglGraph(graphRendererRef.current!==null);
    };
    const lost=(event:Event)=>{
      event.preventDefault();disableWebGL();wakeRef.current();
    };
    restore();
    canvas.addEventListener("webglcontextlost",lost);
    canvas.addEventListener("webglcontextrestored",restore);
    return () => {
      canvas.removeEventListener("webglcontextlost",lost);canvas.removeEventListener("webglcontextrestored",restore);
      graphRendererRef.current?.dispose();graphRendererRef.current=null;
    };
  },[hasGraph,disableWebGL]);

  useLayoutEffect(() => {
    const renderer=graphRendererRef.current;
    if(!renderer)return;
    const styles=drawnEdges.flatMap(edge=>{
      const glow=glowElsRef.current.get(edge.id),core=edgeElsRef.current.get(edge.id);
      if(!glow || !core)return [];
      return [{id:edge.id,glow:getComputedStyle(glow).stroke,core:getComputedStyle(core).stroke,
        dim:!!selected && !sameNode(edge.from,selected) && !sameNode(edge.to,selected),
        leaving:leavingKeys.has(nodeKey(edge.from)) || leavingKeys.has(nodeKey(edge.to))}];
    });
    // Resolve CSS colours after React commits, never between frame writes.
    const nodeStyles:GraphNodeStyle[]=[];
    for(const body of [...bodiesRef.current,...leavingRef.current]){
      const el=nodeElsRef.current.get(body.key),label=el?.querySelector<HTMLElement>(".lc-explore-node-label");
      if(!el || !label)continue;
      const css=getComputedStyle(el),text=getComputedStyle(label);
      const isSelected=!!selected && sameNode(body.node,selected);
      nodeStyles.push({id:body.key,tint:css.getPropertyValue("--lc-node-tint").trim(),diameter:nodeDiameter(degree.get(body.key)??0),
        label:label.textContent??"",font:text.font || `${text.fontSize} ${text.fontFamily}`,lineHeight:parseFloat(text.lineHeight)||14.3,
        selected:isSelected,here:!!here && sameNode(body.node,here),missing:isUnresolved(body.node),
        dim:!!selected && !isSelected && !neighbourKeys.has(body.key),leaving:leavingKeys.has(body.key)});
    }
    const host=hostRef.current;if(!host)return;
    const css=getComputedStyle(host),color=(name:string)=>css.getPropertyValue(name).trim();
    try {
      renderer.setStyles(nodeStyles,styles,{surface:color("--surface"),accent:color("--accent"),ink:color("--ink"),muted:color("--muted")},performance.now(),prefersReducedMotion());
      paint();
    }catch(cause){
      console.warn("Explore GPU styling failed; using HTML/SVG",cause);
      disableWebGL();paintRef.current();
    }
  },[webglGraph,drawnEdges,selected,leavingKeys,themeId,paint,degree,here,neighbourKeys,disableWebGL]);

  useEffect(()=>{
    const loaded=()=>{graphRendererRef.current?.invalidateFonts(performance.now());paint();};
    document.fonts?.addEventListener("loadingdone",loaded);
    return()=>document.fonts?.removeEventListener("loadingdone",loaded);
  },[paint]);

  useEffect(() => {
    clusterReadyRef.current = false;
    setClusterReady(false);
  }, [clustered]);

  useEffect(() => {
    if (!searchOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (chromeRef.current?.contains(target) || findRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [searchOpen]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (active) return;
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
        body.dropped = false;
      }
      setClustered(false);
      return;
    }
    setClustered(true);
  };

  const labels = clustered && clusterReady ? frozenLabels : [];

  const nodeRect = (key:string):DOMRect|null => {
    const body=bodiesRef.current.find(body=>body.key===key),box=hostRef.current?.getBoundingClientRect();
    return body && box ? new DOMRect(box.left+body.x*box.width-20,box.top+body.y*box.height-20,40,40) : null;
  };
  const select = (node: NodeRef, el: HTMLElement | null) => {
    setSheetFrom(graphRendererRef.current ? nodeRect(nodeKey(node)) : el?.getBoundingClientRect() ?? null);
    setSelected(node);
  };
  const hitNode = (clientX:number,clientY:number):Body|undefined => {
    const box=hostRef.current?.getBoundingClientRect();if(!box)return;
    const x=clientX-box.left,y=clientY-box.top;
    return [...bodiesRef.current].reverse().find(body=>Math.abs(body.x*box.width-x)<=20 && Math.abs(body.y*box.height-y)<=20);
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
          <button
            type="button"
            className={
              searchOpen || query.trim() || kinds.length > 0
                ? "lc-lined-toggle lc-tip-target is-active"
                : "lc-lined-toggle lc-tip-target"
            }
            aria-pressed={searchOpen}
            aria-label={searchOpen ? "Hide search" : "Find a workspace"}
            data-tip={searchOpen ? "Hide search" : "Find"}
            data-tip-placement="top"
            onClick={() => setSearchOpen((open) => !open)}
          >
            <SearchIcon />
          </button>

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
    <div className={webglGraph ? "lc-explore is-webgl" : "lc-explore"}>
      {/*
        Searching inside the documents, above the map of them.
        
        The strip below finds nodes by title; this finds passages by meaning.
        They are different questions and deserve different controls — "which
        note is called gradients" and "which of my books talks about
        gradients" have almost nothing to do with each other.
      */}
      <div className="lc-explore-stage" ref={hostRef}>
        <form
          ref={findRef}
          className={searchOpen ? "lc-explore-find is-open" : "lc-explore-find"}
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="lc-explore-find-kinds" role="group" aria-label="Filter by kind">
            {CLUSTERS.map((cluster) => {
              const on = kinds.includes(cluster.type);
              return (
                <button
                  key={cluster.type}
                  type="button"
                  className={on ? "is-filter" : undefined}
                  aria-pressed={on}
                  aria-label={cluster.label}
                  onClick={() => toggleKind(cluster.type)}
                >
                  <span className="lc-explore-chip-dot" style={{ background: TINT[cluster.type] }} />
                  {KIND_SHORT[cluster.type]}
                </button>
              );
            })}
          </div>
          <div className="lc-explore-find-field">
            <input
              ref={searchInputRef}
              type="search"
              value={queryDraft}
              placeholder="Search catalog"
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
                tabIndex={searchOpen ? 0 : -1}
                onClick={() => {
                  setQueryDraft("");
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                ×
              </button>
            ) : null}
            <span className="lc-explore-find-glass" aria-hidden>
              <SearchIcon />
            </span>
          </div>
        </form>
        {showing && chromeHost && (active || inBoardStack)
          ? createPortal(exploreChrome, chromeHost)
          : null}

        {bodiesRef.current.length === 0 && leaving.length === 0 ? (
          <p className="lc-explore-empty">
            {nodes.length === 0
              ? "Nothing in the library yet. Write a note, or open a document to annotate."
              : "Nothing matches that filter."}
          </p>
        ) : (
          <>
            {/*
              GPU drawing uses CSS-derived textures for the existing look.
              HTML buttons preserve keyboard/screen-reader interaction; SVG
              and visible HTML take over if WebGL is unavailable or lost.
            */}
            <canvas className="lc-explore-beams lc-explore-webgl" ref={graphCanvasRef} hidden={!webglGraph} aria-hidden
              onContextMenu={event=>event.preventDefault()}
              onPointerDown={event=>{
                if(event.button!==0)return;
                const body=hitNode(event.clientX,event.clientY);if(!body)return;
                dragNodeRef.current={key:body.key,pointerId:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
                skipNodeClickRef.current=false;event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event=>{
                const drag=dragNodeRef.current;
                if(!drag){hoveredNodeRef.current=event.pointerType==="touch"?null:hitNode(event.clientX,event.clientY)?.key??null;paint();return;}
                if(drag.pointerId!==event.pointerId)return;
                const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved && dx*dx+dy*dy<100)return;
                drag.moved=true;skipNodeClickRef.current=true;pinnedKeyRef.current=drag.key;
                placeDragged(drag.key,event.clientX,event.clientY);
              }}
              onPointerLeave={()=>{hoveredNodeRef.current=null;paint();}}
              onPointerUp={event=>{
                const drag=dragNodeRef.current;if(!drag || drag.pointerId!==event.pointerId)return;
                const body=bodiesRef.current.find(body=>body.key===drag.key);
                if(body){if(drag.moved){body.parkedX=body.x;body.parkedY=body.y;body.dropped=true;}else select(body.node,null);}
                pinnedKeyRef.current=null;dragNodeRef.current=null;skipNodeClickRef.current=false;
              }}
              onPointerCancel={()=>{pinnedKeyRef.current=null;dragNodeRef.current=null;skipNodeClickRef.current=false;}}
            />
            <svg className={webglGraph ? "lc-explore-beams is-rasterized" : "lc-explore-beams"} aria-hidden>
              {/*
                The bloom: a wide, faint coloured copy of every edge, with a
                thinner bright core drawn over it. No blur filter: the layer
                redraws every frame, and a blur over all of it is too costly.
              */}
              <g className="lc-explore-beam-glow">
                {drawnEdges.map((edge) => {
                  const touched =
                    !selected || sameNode(edge.from, selected) || sameNode(edge.to, selected);
                  const fading = edgeFading(edge);
                  return (
                    <path
                      key={edge.id}
                      ref={(el) => {
                        if (el) glowElsRef.current.set(edge.id, el);
                        else glowElsRef.current.delete(edge.id);
                      }}
                      className={`lc-explore-beam is-${edge.kind}${touched ? "" : " is-dim"}${fading ? " is-leaving" : ""}`}
                    />
                  );
                })}
              </g>

              <g className="lc-explore-beam-core">
                {drawnEdges.map((edge) => {
                  const touched =
                    !selected || sameNode(edge.from, selected) || sameNode(edge.to, selected);
                  const fading = edgeFading(edge);
                  return (
                    <path
                      key={edge.id}
                      ref={(el) => {
                        if (el) edgeElsRef.current.set(edge.id, el);
                        else edgeElsRef.current.delete(edge.id);
                      }}
                      className={`lc-explore-beam is-${edge.kind}${touched ? "" : " is-dim"}${fading ? " is-leaving" : ""}`}
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
              {[
                ...bodiesRef.current.map((body) => ({ body, fading: false })),
                ...leaving
                  .filter((body) => !bodiesRef.current.some((live) => live.key === body.key))
                  .map((body) => ({ body, fading: true })),
              ].map(({ body, fading }) => {
                const key = body.key;
                const isSelected = selected ? sameNode(body.node, selected) : false;
                const dim = Boolean(selected) && !isSelected && !neighbourKeys.has(key);
                const live = here ? sameNode(body.node, here) : false;
                return (
                  <button
                    key={key}
                    type="button"
                    ref={(el) => {
                      if (el) {
                        nodeElsRef.current.set(key, el);
                        el.style.transform=`translate3d(${body.x*boxRef.current.w}px, ${body.y*boxRef.current.h}px, 0) translate(-50%, -50%)`;
                      }
                      else nodeElsRef.current.delete(key);
                    }}
                    className={[
                      "lc-explore-node",
                      `is-${body.node.type}`,
                      isSelected ? "is-selected" : "",
                      dim ? "is-dim" : "",
                      live ? "is-here" : "",
                      fading ? "is-leaving" : "",
                      isUnresolved(body.node) ? "is-missing" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      ["--lc-node-tint" as string]: TINT[body.node.type],
                      ["--lc-node-size" as string]: `${nodeDiameter(degree.get(key) ?? 0)}px`,
                    }}
                    aria-pressed={isSelected}
                    data-node-key={key}
                    onFocus={()=>{focusedNodeRef.current=key;paint();}}
                    onBlur={()=>{focusedNodeRef.current=null;paint();}}
                    onContextMenu={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                      if (fading || event.button !== 0) return;
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
                        body.dropped = true;
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
                      if (fading) return;
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
            setSheetFrom(graphRendererRef.current ? nodeRect(nodeKey(node)) : el?.getBoundingClientRect() ?? sheetFrom);
            setSelected(node);
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
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
