/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse, Explore.
 *
 * There is no longer a "What do you want to do?" banner over the cards.
 * The four cards answer that question by existing.
 *
 * Cards stack in one column so the icon, colored name and full blurb stay on
 * every device instead of collapsing into a cramped row of tiles.
 * `homeModeColumns` is kept for the older multi-column layout tests.
 *
 * Practice, Whiteboard and Annotate play hover-in / hover-out scenes. Browse
 * and Explore keep a quiet loop. Marks and doodles are real SVG, not a
 * wallpaper that fades in all at once.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { FEATURE_LEETCODE } from "../featureFlags";

export interface HomeChooserProps {
  onPractice: () => void;
  onWhiteboard: () => void;
  onAnnotate: () => void;
  /** Opens google.com as a snapshot pad — same entry as the header globe. */
  onBrowse: () => void;
  /** The notes graph — one tab, see `EXPLORE_TAB_LIMIT`. */
  onExplore: () => void;
  /** Something is already opening; the cards stop taking taps. */
  busy?: boolean;
}

interface HomeMode {
  id: string;
  kicker: string;
  blurb: string;
  icon: ReactNode;
  live?: ReactNode;
  /** In-progress surface — a quiet corner mark, not a disabled card. */
  wip?: boolean;
  onOpen: () => void;
}

type IconScene = "rest" | "in" | "out";

const HOVER_SCENES = new Set(["practice", "whiteboard", "annotate"]);
const LEAVE_MS: Record<string, number> = { practice: 1500, whiteboard: 980, annotate: 400 };
/** First pose of `lc-home-nib-write` — stick-figure head, still on a blank page. */
const NIB_WRITE_START = "translate(38.54%, 56.67%) rotate(-8deg)";
const NIB_PARK = "translate(67.5%, 46.67%) rotate(18deg)";
const NIB_APPROACH_MS = 560;

function whiteboardNib(card: HTMLElement | null): SVGElement | null {
  const el = card?.querySelector(".lc-home-nib-arm");
  return el instanceof SVGElement ? el : null;
}

function clearNibInline(arm: SVGElement | null) {
  if (!arm) return;
  arm.style.animation = "";
  arm.style.transition = "";
  arm.style.transform = "";
}

function freezeWhiteboardNib(card: HTMLElement | null) {
  const arm = whiteboardNib(card);
  if (!arm || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const computed = getComputedStyle(arm).transform;
  arm.style.transition = "none";
  arm.style.animation = "none";
  arm.style.transform = computed === "none" ? NIB_PARK : computed;
  return true;
}

function approachWhiteboardNib(card: HTMLElement | null) {
  const arm = whiteboardNib(card);
  if (!arm) return;
  arm.style.animation = "";
  arm.getBoundingClientRect();
  arm.style.transition = `transform ${NIB_APPROACH_MS}ms cubic-bezier(0.22, 0.68, 0.28, 1)`;
  arm.style.transform = NIB_WRITE_START;
}

/** Same folded page for Whiteboard and Annotate so the icons read as one size. */
const PAGE_PATH = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z";
const PAGE_FOLD = "M15 2v6h6";

const WEB_NET_ROUTES = [
  "M6 28C14 8 38 8 46 28",
  "M6 24C14 44 38 44 46 24",
  "M-4 10C16 6 36 20 56 44",
  "M56 8C36 18 14 28 -6 44",
  "M24 18C12 6 0 -6 -10 -14",
  "M30 16C42 4 54 -6 64 -14",
  "M20 34C8 46 -4 56 -12 64",
  "M34 34C48 46 60 56 68 64",
  "M16 22C4 18 -8 8 -16 0",
  "M36 30C48 36 60 48 68 58",
];

/**
 * Columns for the middle tier, where cards are still full but two abreast.
 *
 * An even count halves cleanly (4 → 2×2). An odd one does not, so it keeps its
 * full width and skips this tier — 3 → 2 would put one card alone underneath,
 * which is the exact asymmetry the tier exists to avoid.
 */
export function homeModeColumns(count: number): number {
  if (count <= 1) return 1;
  return count % 2 === 0 ? count / 2 : count;
}

/** Shared geometry for the card glyphs — one stroke weight across all four. */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function typeLine(text: string): ReactNode {
  return (
    <span
      className="lc-home-fn-line"
      style={{ "--lc-ch": `${Math.max(text.length, 1)}ch` } as CSSProperties}
    >
      {text}
    </span>
  );
}

function PracticeLive() {
  return (
    <span className="lc-home-live lc-home-live-code">
      <span className="lc-home-fn lc-home-fn-a">
        {typeLine("fn two_sum(a,t){")}
        {typeLine("  m.insert(x,i)")}
        {typeLine("  Ok([j,i])")}
        {typeLine("}")}
      </span>
      <span className="lc-home-fn lc-home-fn-b">
        {typeLine("fn reverse(h) {")}
        {typeLine("  p.next = h")}
        {typeLine("  h = n;")}
        {typeLine("}")}
      </span>
    </span>
  );
}

function BrowseLive() {
  return (
    <span className="lc-home-live">
      <svg viewBox="0 0 52 52" className="lc-home-live-svg" aria-hidden="true">
        {WEB_NET_ROUTES.slice(0, 4).map((d, i) => (
          <path key={`mesh-${i}`} className="lc-home-net-mesh" d={d} />
        ))}
        {WEB_NET_ROUTES.map((d, i) => (
          <path
            key={`flow-${i}`}
            className={`lc-home-net-flow lc-home-net-flow-${i + 1}`}
            d={d}
            pathLength={100}
          />
        ))}
      </svg>
    </span>
  );
}

function ExploreLive() {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const root = svgRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const NS = "http://www.w3.org/2000/svg";
    const W = 52;
    const H = 52;
    const pad = 5;
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", "lc-home-graph");
    root.appendChild(layer);

    type GraphNode = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      exiting: boolean;
      el: SVGCircleElement;
    };
    type GraphEdge = {
      a: GraphNode;
      b: GraphNode;
      born: number;
      life: number;
      el: SVGLineElement;
    };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    function spawnNode(fromEdge: boolean): GraphNode {
      const el = document.createElementNS(NS, "circle");
      el.setAttribute("class", "lc-home-graph-node");
      el.setAttribute("r", String(rand(0.85, 1.35)));
      el.setAttribute("fill", "currentColor");
      el.setAttribute("stroke", "none");
      layer.appendChild(el);
      const side = Math.floor(Math.random() * 4);
      const rim = 11;
      let x = rand(pad, W - pad);
      let y = rand(pad, H - pad);
      let vx = rand(-8, 8);
      let vy = rand(-8, 8);
      if (side === 0) {
        x = fromEdge ? -3 : rand(pad, W - pad);
        y = fromEdge ? rand(pad, H - pad) : rand(pad, rim);
        vx = fromEdge ? rand(10, 18) : rand(-10, 10);
        vy = fromEdge ? rand(-6, 6) : rand(2, 10);
      } else if (side === 1) {
        x = fromEdge ? W + 3 : rand(pad, W - pad);
        y = fromEdge ? rand(pad, H - pad) : rand(H - rim, H - pad);
        vx = fromEdge ? -rand(10, 18) : rand(-10, 10);
        vy = fromEdge ? rand(-6, 6) : -rand(2, 10);
      } else if (side === 2) {
        x = fromEdge ? rand(pad, W - pad) : rand(pad, rim);
        y = fromEdge ? -3 : rand(pad, H - pad);
        vx = fromEdge ? rand(-6, 6) : rand(2, 10);
        vy = fromEdge ? rand(10, 18) : rand(-10, 10);
      } else {
        x = fromEdge ? rand(pad, W - pad) : rand(W - rim, W - pad);
        y = fromEdge ? H + 3 : rand(pad, H - pad);
        vx = fromEdge ? rand(-6, 6) : -rand(2, 10);
        vy = fromEdge ? -rand(10, 18) : rand(-10, 10);
      }
      const node: GraphNode = { x, y, vx, vy, exiting: false, el };
      nodes.push(node);
      return node;
    }

    for (let i = 0; i < 6; i++) spawnNode(false);

    let last = performance.now();
    let nextEdge = last + 280;
    let nextExit = last + 1600;
    let nextBreak = last + 2200;
    let raf = 0;

    function breakEdge(edge: GraphEdge) {
      edge.el.remove();
      const i = edges.indexOf(edge);
      if (i >= 0) edges.splice(i, 1);
    }

    function linked(a: GraphNode, b: GraphNode) {
      return edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    }

    function addEdge(now: number) {
      if (edges.length >= 7 || nodes.length < 2) return;
      const a = nodes[Math.floor(Math.random() * nodes.length)]!;
      let best: GraphNode | undefined;
      let bestD = 30;
      for (const b of nodes) {
        if (b === a || linked(a, b)) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (!best) return;
      const el = document.createElementNS(NS, "line");
      el.setAttribute("class", "lc-home-graph-edge");
      el.setAttribute("stroke", "currentColor");
      el.setAttribute("stroke-width", "0.9");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("fill", "none");
      el.setAttribute("opacity", "0");
      layer.insertBefore(el, layer.firstChild);
      edges.push({ a, b: best, born: now, life: rand(1200, 2600), el });
    }

    function tick(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (now >= nextEdge) {
        addEdge(now);
        nextEdge = now + rand(320, 860);
      }
      if (now >= nextBreak && edges.length) {
        breakEdge(edges[Math.floor(Math.random() * edges.length)]!);
        nextBreak = now + rand(900, 1800);
      }
      if (now >= nextExit && nodes.length) {
        const n = nodes[Math.floor(Math.random() * nodes.length)]!;
        n.exiting = true;
        n.vx *= 2.2;
        n.vy *= 2.2;
        if (Math.abs(n.vx) < 9) n.vx = (n.vx < 0 ? -1 : 1) * rand(11, 18);
        if (Math.abs(n.vy) < 9) n.vy = (n.vy < 0 ? -1 : 1) * rand(9, 16);
        nextExit = now + rand(1400, 2600);
      }

      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (!n.exiting) {
          if (n.x < pad || n.x > W - pad) n.vx *= -1;
          if (n.y < pad || n.y > H - pad) n.vy *= -1;
          n.x = Math.min(W - pad, Math.max(pad, n.x));
          n.y = Math.min(H - pad, Math.max(pad, n.y));
          n.vx += rand(-5, 5) * dt;
          n.vy += rand(-5, 5) * dt;
          const sp = Math.hypot(n.vx, n.vy);
          if (sp > 15) {
            n.vx *= 15 / sp;
            n.vy *= 15 / sp;
          }
          if (sp < 3.2) {
            n.vx *= 1.5;
            n.vy *= 1.5;
          }
        }
        n.el.setAttribute("cx", n.x.toFixed(2));
        n.el.setAttribute("cy", n.y.toFixed(2));
      }

      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        if (!n.exiting) continue;
        if (n.x < -7 || n.x > W + 7 || n.y < -7 || n.y > H + 7) {
          for (let j = edges.length - 1; j >= 0; j--) {
            const e = edges[j]!;
            if (e.a === n || e.b === n) breakEdge(e);
          }
          n.el.remove();
          nodes.splice(i, 1);
          spawnNode(true);
        }
      }

      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i]!;
        const age = now - e.born;
        if (age > e.life) {
          breakEdge(e);
          continue;
        }
        const fadeIn = Math.min(1, age / 160);
        const fadeOut = Math.min(1, (e.life - age) / 200);
        e.el.setAttribute("x1", e.a.x.toFixed(2));
        e.el.setAttribute("y1", e.a.y.toFixed(2));
        e.el.setAttribute("x2", e.b.x.toFixed(2));
        e.el.setAttribute("y2", e.b.y.toFixed(2));
        e.el.setAttribute("opacity", (0.78 * Math.min(fadeIn, fadeOut)).toFixed(3));
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      layer.remove();
    };
  }, []);

  return (
    <span className="lc-home-live">
      <svg ref={svgRef} viewBox="0 0 52 52" className="lc-home-live-svg" aria-hidden="true" />
    </span>
  );
}

export function HomeChooser({
  onPractice,
  onWhiteboard,
  onAnnotate,
  onBrowse,
  onExplore,
  busy = false,
}: HomeChooserProps) {
  const modes: HomeMode[] = [
    ...(FEATURE_LEETCODE
      ? [
          {
            id: "practice",
            kicker: "LeetCode",
            blurb: "Browse problems and run tests in this app.",
            live: <PracticeLive />,
            icon: (
              <Glyph>
                <path className="lc-home-bra-l" d="m9 8-3.5 4L9 16" />
                <path className="lc-home-bra-r" d="m15 8 3.5 4L15 16" />
                <path className="lc-home-slash" d="M13.4 5.5 10.6 18.5" />
              </Glyph>
            ),
            onOpen: onPractice,
          } satisfies HomeMode,
        ]
      : []),
    {
      id: "annotate",
      kicker: "Annotate",
      blurb: "Mark up PDFs, docs, code, and web pages.",
      icon: (
        <Glyph className="lc-home-glyph-sheet">
          <defs>
            <clipPath id="lc-home-ann-clip" clipPathUnits="userSpaceOnUse">
              <path d={PAGE_PATH} />
            </clipPath>
          </defs>
          <path d={PAGE_PATH} />
          <path d={PAGE_FOLD} />
          <g clipPath="url(#lc-home-ann-clip)">
            <path
              className="lc-home-mark lc-home-mark-a-hl"
              d="M6.6 11.3h9.2"
              stroke="#eab308"
              strokeWidth="2.35"
              pathLength={1}
            />
            <path className="lc-home-rule lc-home-rule-1" d="M6.6 9.3h10.4" pathLength={1} />
            <path className="lc-home-rule lc-home-rule-2" d="M6.6 11.3h9.2" pathLength={1} />
            <path className="lc-home-rule lc-home-rule-3" d="M6.6 13.3h10.4" pathLength={1} />
            <path className="lc-home-rule lc-home-rule-4" d="M6.6 15.3h8.6" pathLength={1} />
            <path className="lc-home-rule lc-home-rule-5" d="M6.6 17.3h10.4" pathLength={1} />
            <path className="lc-home-rule lc-home-rule-6" d="M6.6 19.3h7.4" pathLength={1} />
            <path
              className="lc-home-mark lc-home-mark-a-ul"
              d="M6.6 13.95h8.1"
              stroke="#3b82f6"
              strokeWidth="1.05"
              pathLength={1}
            />
            <rect
              className="lc-home-box lc-home-box-a"
              x="14.4"
              y="8.35"
              width="3.2"
              height="2.15"
              rx="0.35"
              fill="#fbbf24"
              stroke="none"
            />
            <rect
              className="lc-home-box lc-home-box-a2"
              x="7"
              y="16.15"
              width="2.9"
              height="2"
              rx="0.35"
              fill="#60a5fa"
              stroke="none"
            />
            <path
              className="lc-home-mark lc-home-mark-b-ul"
              d="M6.6 11.95h7.6"
              stroke="#22c55e"
              strokeWidth="1.05"
              pathLength={1}
            />
            <path
              className="lc-home-mark lc-home-mark-b-strike"
              d="M6.8 17.3h7.8"
              stroke="#f43f5e"
              strokeWidth="1.05"
              pathLength={1}
            />
            <rect
              className="lc-home-box lc-home-box-b"
              x="14.6"
              y="14.35"
              width="3.1"
              height="2.1"
              rx="0.35"
              fill="#f9a8d4"
              stroke="none"
            />
            <rect
              className="lc-home-box lc-home-box-b2"
              x="7.1"
              y="8.4"
              width="2.8"
              height="1.95"
              rx="0.35"
              fill="#c4b5fd"
              stroke="none"
            />
          </g>
        </Glyph>
      ),
      onOpen: onAnnotate,
    },
    {
      id: "whiteboard",
      kicker: "Whiteboard",
      blurb: "Freeform pages for sketches, notes, and diagrams.",
      icon: (
        <Glyph className="lc-home-glyph-sheet">
          <defs>
            <clipPath id="lc-home-wb-clip" clipPathUnits="userSpaceOnUse">
              <path d={PAGE_PATH} />
            </clipPath>
          </defs>
          <path d={PAGE_PATH} />
          <path d={PAGE_FOLD} />
          <g clipPath="url(#lc-home-wb-clip)">
            <g className="lc-home-wb-scroll">
              <g className="lc-home-wb-draw-a">
                <circle className="lc-home-draw" cx="8.2" cy="13.6" r="1.05" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 14.7v3.1" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 15.8 6.8 17" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 15.8 9.7 16.9" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 17.8 7 19.8" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 17.8 9.5 19.8" pathLength={1} />
                <path
                  className="lc-home-draw"
                  d="M13.4 9.2c1.1-1.4 2.6.7 3.8-.3 1.1 1.3 2.1-.5 3.3.9"
                  pathLength={1}
                />
              </g>
              <g className="lc-home-wb-draw-b">
                <path className="lc-home-draw" d="M7.1 10.2h5.8v4.4H7.1z" pathLength={1} />
                <path className="lc-home-draw" d="M8 16.8h9.6" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 16.8 11 12.8 13.3 14.9 17 10.4" pathLength={1} />
                <path className="lc-home-draw" d="M16.3 10.4h1.5v1.5" pathLength={1} />
              </g>
            </g>
          </g>
          <g className="lc-home-nib-arm">
            <path
              className="lc-home-nib"
              d="m20.4 10.8-6.4 6.4-2.7.8.8-2.7 6.4-6.4z"
              transform="translate(-11.3 -18)"
            />
          </g>
        </Glyph>
      ),
      onOpen: onWhiteboard,
    },
    {
      id: "browse",
      kicker: "Web",
      blurb: "Open a page, then write straight onto the snapshot.",
      wip: true,
      live: <BrowseLive />,
      icon: (
        <Glyph>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M2.5 12h19" />
          <path d="M12 2.5a14.5 14.5 0 0 1 3.8 9.5 14.5 14.5 0 0 1-3.8 9.5 14.5 14.5 0 0 1-3.8-9.5A14.5 14.5 0 0 1 12 2.5z" />
        </Glyph>
      ),
      onOpen: onBrowse,
    },
    {
      id: "explore",
      kicker: "Explore",
      blurb: "See how files, notebooks, and problems connect.",
      wip: true,
      live: <ExploreLive />,
      icon: (
        <Glyph>
          <circle cx="12" cy="12" r="2.6" />
          <circle cx="5" cy="6.5" r="1.5" />
          <circle cx="19.2" cy="7.5" r="1.5" />
          <circle cx="6.5" cy="18.5" r="1.5" />
          <circle cx="18" cy="17.5" r="1.5" />
          <path d="M6.2 7.5 10 10.6" />
          <path d="M18 8.6 14.2 10.9" />
          <path d="M7.6 17.4 10.4 13.9" />
          <path d="M16.9 16.5 13.9 13.6" />
        </Glyph>
      ),
      onOpen: onExplore,
    },
  ];

  return (
    <nav className="lc-home-chooser" aria-label="Choose a workspace">
      <div className="lc-home-chooser-grid">
        {modes.map((mode) => (
          <HomeCard key={mode.id} mode={mode} busy={busy} />
        ))}
      </div>
    </nav>
  );
}

/**
 * Hover scenes: rest loop, `in` on enter, `out` on leave, then rest after LEAVE_MS.
 * Re-enter during `out` clears that timer and goes back to `in` (drawings stay paused
 * on leave via CSS, then resume if the animation name is unchanged).
 * Whiteboard `rest` → `in` freezes the nib wherever it is, walks it onto the blank
 * page, then starts the draw loop (ink is delayed to match).
 */
function HomeCard({ mode, busy }: { mode: HomeMode; busy: boolean }) {
  const [scene, setScene] = useState<IconScene>("rest");
  const sceneRef = useRef<IconScene>(scene);
  sceneRef.current = scene;
  const cardRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef(0);
  const approachTimer = useRef(0);
  const approaching = useRef(false);
  const hoverable = HOVER_SCENES.has(mode.id);
  useEffect(() => () => {
    window.clearTimeout(leaveTimer.current);
    window.clearTimeout(approachTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (scene !== "in" || !approaching.current) return;
    approachWhiteboardNib(cardRef.current);
    window.clearTimeout(approachTimer.current);
    approachTimer.current = window.setTimeout(() => {
      approaching.current = false;
      clearNibInline(whiteboardNib(cardRef.current));
    }, NIB_APPROACH_MS + 40);
    return () => window.clearTimeout(approachTimer.current);
  }, [scene]);
  return (
    <span className="lc-home-cell">
      <button
        ref={cardRef}
        type="button"
        className="lc-home-card"
        data-mode={mode.id}
        data-scene={hoverable ? scene : undefined}
        aria-label={`${mode.kicker} — ${mode.blurb}${mode.wip ? " (work in progress)" : ""}`}
        disabled={busy}
        onClick={mode.onOpen}
        onMouseEnter={hoverable ? () => {
          window.clearTimeout(leaveTimer.current);
          if (mode.id === "whiteboard" && sceneRef.current === "rest") {
            approaching.current = freezeWhiteboardNib(cardRef.current);
          }
          setScene("in");
        } : undefined}
        onMouseLeave={hoverable ? () => {
          approaching.current = false;
          window.clearTimeout(approachTimer.current);
          clearNibInline(whiteboardNib(cardRef.current));
          setScene("out");
          window.clearTimeout(leaveTimer.current);
          leaveTimer.current = window.setTimeout(
            () => setScene("rest"),
            LEAVE_MS[mode.id] ?? 400,
          );
        } : undefined}
      >
        {mode.wip ? <span className="lc-home-wip">(WIP)</span> : null}
        <span className="lc-home-card-icon" aria-hidden>
          {mode.live}
          {mode.icon}
        </span>
        <span className="lc-home-card-text">
          <span className="lc-home-card-kicker">{mode.kicker}</span>
          <span className="lc-home-card-blurb">{mode.blurb}</span>
        </span>
      </button>
    </span>
  );
}
