/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse, Explore.
 *
 * There is no longer a "What do you want to do?" banner over the cards. The
 * header already says `choose a mode to start`, and the question was asking
 * something the four cards answer by existing.
 *
 * Cards stack in one column so the icon, colored name and full blurb stay on
 * every device instead of collapsing into a cramped row of tiles.
 * `homeModeColumns` is kept for the older multi-column layout tests.
 *
 * Practice, Whiteboard and Annotate play hover-in / hover-out scenes. Browse
 * and Explore keep a quiet loop. Marks and doodles are real SVG, not a
 * wallpaper that fades in all at once.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
const LEAVE_MS: Record<string, number> = { practice: 1500, whiteboard: 700, annotate: 280 };

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
        <defs>
          <linearGradient id="lc-home-meteor-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.55" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <g className="lc-home-meteor lc-home-meteor-1">
          <line
            x1="-18"
            y1="0"
            x2="0"
            y2="0"
            stroke="url(#lc-home-meteor-fade)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="0" cy="0" r="1.2" fill="currentColor" stroke="none" />
        </g>
        <g className="lc-home-meteor lc-home-meteor-2">
          <line
            x1="-15"
            y1="0"
            x2="0"
            y2="0"
            stroke="url(#lc-home-meteor-fade)"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
          <circle cx="0" cy="0" r="1" fill="currentColor" stroke="none" />
        </g>
        <g className="lc-home-meteor lc-home-meteor-3">
          <line
            x1="-16"
            y1="0"
            x2="0"
            y2="0"
            stroke="url(#lc-home-meteor-fade)"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <circle cx="0" cy="0" r="1.05" fill="currentColor" stroke="none" />
        </g>
        <g className="lc-home-meteor lc-home-meteor-4">
          <line
            x1="-12"
            y1="0"
            x2="0"
            y2="0"
            stroke="url(#lc-home-meteor-fade)"
            strokeWidth="1"
            strokeLinecap="round"
          />
          <circle cx="0" cy="0" r="0.9" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </span>
  );
}

function ExploreLive() {
  return (
    <span className="lc-home-live">
      <svg viewBox="0 0 52 52" className="lc-home-live-svg" aria-hidden="true">
        <g className="lc-home-sparks" fill="currentColor" stroke="none">
          <circle className="lc-home-spark" cx="7" cy="9" r="0.85" />
          <circle className="lc-home-spark" cx="41" cy="7" r="0.7" />
          <circle className="lc-home-spark" cx="46" cy="22" r="0.8" />
          <circle className="lc-home-spark" cx="6" cy="28" r="0.6" />
          <circle className="lc-home-spark" cx="38" cy="44" r="0.75" />
          <circle className="lc-home-spark" cx="14" cy="46" r="0.65" />
          <circle className="lc-home-spark" cx="25" cy="5" r="0.55" />
          <circle className="lc-home-spark" cx="48" cy="38" r="0.6" />
        </g>
      </svg>
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
      id: "whiteboard",
      kicker: "Whiteboard",
      blurb: "Freeform pages for sketches, notes, and diagrams.",
      icon: (
        <Glyph className="lc-home-glyph-sheet">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M15 2v6h6" />
          <g className="lc-home-stick" fill="none">
            <circle className="lc-home-stick-head" cx="8.2" cy="13.6" r="1.05" pathLength={1} />
            <path d="M8.2 14.7v3.1" pathLength={1} />
            <path d="M8.2 15.8 6.8 17" pathLength={1} />
            <path d="M8.2 15.8 9.7 16.9" pathLength={1} />
            <path d="M8.2 17.8 7 19.8" pathLength={1} />
            <path d="M8.2 17.8 9.5 19.8" pathLength={1} />
          </g>
          <path
            className="lc-home-scribble"
            d="M13.4 9.2c1.1-1.4 2.6.7 3.8-.3 1.1 1.3 2.1-.5 3.3.9"
            pathLength={1}
          />
          <path
            className="lc-home-note"
            d="M12.8 16.6c1.5-.5 2.4 1.1 3.8.2 1.3.9 2.2-.5 3.4.7"
            pathLength={1}
          />
          <path className="lc-home-nib" d="m20.4 10.8-6.4 6.4-2.7.8.8-2.7 6.4-6.4z" />
        </Glyph>
      ),
      onOpen: onWhiteboard,
    },
    {
      id: "annotate",
      kicker: "Annotate",
      blurb: "Mark up PDFs, docs, code, and web pages.",
      icon: (
        <Glyph className="lc-home-glyph-page">
          <path d="M15.2 1.4H5.2A2.1 2.1 0 0 0 3.1 3.5v17a2.1 2.1 0 0 0 2.1 2.1h13.6a2.1 2.1 0 0 0 2.1-2.1V7.6z" />
          <path d="M15.2 1.4v6.2h6.2" />
          <path className="lc-home-bt-top" d="M6.6 9.6h10.6" pathLength={1} />
          <path className="lc-home-bt-mid" d="M6.6 11.45h10.6" pathLength={1} />
          <path className="lc-home-rule-1" d="M6.6 13.4h10.6" pathLength={1} />
          <path className="lc-home-rule-2" d="M6.6 15.35h9.2" pathLength={1} />
          <path className="lc-home-rule-3" d="M6.6 17.3h10.6" pathLength={1} />
          <path className="lc-home-bt-bot" d="M6.6 19.4h10.6" pathLength={1} />
          <rect
            className="lc-home-mark lc-home-mark-hl-a"
            x="6.3"
            y="12.7"
            width="11"
            height="1.55"
            rx="0.25"
            fill="#f5d76e"
            stroke="none"
          />
          <path
            className="lc-home-mark lc-home-mark-ul"
            d="M6.6 16.05h8.4"
            stroke="#3b82f6"
            strokeWidth="1.15"
            pathLength={1}
          />
          <path
            className="lc-home-mark lc-home-mark-brace"
            d="M5.7 12.5v5.4"
            stroke="#22c55e"
            strokeWidth="1.35"
            pathLength={1}
          />
          <path
            className="lc-home-mark lc-home-mark-strike"
            d="M6.8 18.05h8.2"
            stroke="#f43f5e"
            strokeWidth="1.2"
            pathLength={1}
          />
          <circle
            className="lc-home-mark lc-home-mark-fn"
            cx="18.15"
            cy="10.15"
            r="1.15"
            fill="none"
            stroke="#a78bfa"
            strokeWidth="1.2"
            pathLength={1}
          />
          <rect
            className="lc-home-mark lc-home-mark-hl-b"
            x="6.3"
            y="16.6"
            width="11"
            height="1.5"
            rx="0.25"
            fill="#86efac"
            stroke="none"
          />
          <g className="lc-home-panel lc-home-panel-a">
            <rect x="14.6" y="11.8" width="6.8" height="4.3" rx="0.7" />
            <path d="M15.5 13.15h5M15.5 14.45h3.6" />
          </g>
          <g className="lc-home-panel lc-home-panel-b">
            <rect x="2.2" y="15.6" width="6.2" height="3.9" rx="0.65" />
            <path d="M3.05 16.85h4.4M3.05 18.05h2.9" />
          </g>
        </Glyph>
      ),
      onOpen: onAnnotate,
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

function HomeCard({ mode, busy }: { mode: HomeMode; busy: boolean }) {
  const [scene, setScene] = useState<IconScene>("rest");
  const leaveTimer = useRef(0);
  const hoverable = HOVER_SCENES.has(mode.id);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  return (
    <span className="lc-home-cell">
      <button
        type="button"
        className="lc-home-card"
        data-mode={mode.id}
        data-scene={hoverable ? scene : undefined}
        aria-label={`${mode.kicker} — ${mode.blurb}${mode.wip ? " (work in progress)" : ""}`}
        disabled={busy}
        onClick={mode.onOpen}
        onMouseEnter={hoverable ? () => {
          window.clearTimeout(leaveTimer.current);
          setScene("in");
        } : undefined}
        onMouseLeave={hoverable ? () => {
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
