/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse, Explore.
 *
 * There is no longer a "What do you want to do?" banner over the cards. The
 * header already says `choose a mode to start`, and the question was asking
 * something the four cards answer by existing.
 *
 * Cards stack in one column so the icon, title and full blurb stay on every
 * device instead of collapsing into a cramped row of tiles. `homeModeColumns`
 * is kept for the older multi-column layout tests.
 *
 * Each icon tile runs a small looping scene (type, draw, mark, meteor) so the
 * glyph is never a static stamp. Marks appear one after another and wipe off;
 * they are real SVG/HTML, not a wallpaper that fades in all at once.
 */

import type { CSSProperties, ReactNode } from "react";

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
  title: string;
  blurb: string;
  icon: ReactNode;
  live?: ReactNode;
  /** In-progress surface — a quiet corner mark, not a disabled card. */
  wip?: boolean;
  onOpen: () => void;
}

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
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
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
            title: "Practice",
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
      kicker: "Scratch",
      title: "Whiteboard",
      blurb: "Freeform pages for sketches, notes, and diagrams.",
      icon: (
        // Page + nib stay put. The doodles draw, sit, and wipe in sequence on
        // the page — a stick figure, a scribble that gets erased, a note line.
        <Glyph>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
          <path d="M13 2v6h6V9" />
          <g className="lc-home-stick" fill="none">
            <circle className="lc-home-stick-head" cx="7.6" cy="14.4" r="1.05" pathLength={1} />
            <path d="M7.6 15.5v3.1" pathLength={1} />
            <path d="M7.6 16.6 6.2 17.8" pathLength={1} />
            <path d="M7.6 16.6 9.1 17.7" pathLength={1} />
            <path d="M7.6 18.6 6.4 20.6" pathLength={1} />
            <path d="M7.6 18.6 8.9 20.6" pathLength={1} />
          </g>
          <path
            className="lc-home-scribble"
            d="M14.6 8.2c1.1-1.4 2.6.7 3.8-.3 1.1 1.3 2.1-.5 3.3.9"
            pathLength={1}
          />
          <path
            className="lc-home-note"
            d="M13.8 17.4c1.5-.5 2.4 1.1 3.8.2 1.3.9 2.2-.5 3.4.7"
            pathLength={1}
          />
          <path className="lc-home-nib" d="m20.2 11.3-6.6 6.6-2.8.8.8-2.8 6.6-6.6z" />
        </Glyph>
      ),
      onOpen: onWhiteboard,
    },
    {
      id: "annotate",
      kicker: "Reading",
      title: "Annotate",
      blurb: "Mark up PDFs, docs, code, and web pages.",
      icon: (
        <Glyph>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path className="lc-home-bt-top" d="M8 10.4h8.2" pathLength={1} />
          <path className="lc-home-bt-mid" d="M8 12.15h8.2" pathLength={1} />
          <path className="lc-home-rule-1" d="M8 14h8.2" pathLength={1} />
          <path className="lc-home-rule-2" d="M8 15.85h7.2" pathLength={1} />
          <path className="lc-home-rule-3" d="M8 17.7h8.2" pathLength={1} />
          <path className="lc-home-bt-bot" d="M8 19.7h8.2" pathLength={1} />
          <rect
            className="lc-home-mark lc-home-mark-hl-a"
            x="7.7"
            y="13.35"
            width="8.6"
            height="1.55"
            rx="0.25"
            fill="#f5d76e"
            stroke="none"
          />
          <path
            className="lc-home-mark lc-home-mark-ul"
            d="M8 16.55h6.6"
            stroke="#3b82f6"
            strokeWidth="1.15"
            pathLength={1}
          />
          <path
            className="lc-home-mark lc-home-mark-brace"
            d="M7.15 13.2v5.1"
            stroke="#22c55e"
            strokeWidth="1.35"
            pathLength={1}
          />
          <path
            className="lc-home-mark lc-home-mark-strike"
            d="M8.2 18.35h6.4"
            stroke="#f43f5e"
            strokeWidth="1.2"
            pathLength={1}
          />
          <circle
            className="lc-home-mark lc-home-mark-fn"
            cx="17.55"
            cy="10.55"
            r="1.15"
            fill="none"
            stroke="#a78bfa"
            strokeWidth="1.2"
            pathLength={1}
          />
          <rect
            className="lc-home-mark lc-home-mark-hl-b"
            x="7.7"
            y="17.05"
            width="8.6"
            height="1.5"
            rx="0.25"
            fill="#86efac"
            stroke="none"
          />
        </Glyph>
      ),
      onOpen: onAnnotate,
    },
    {
      id: "browse",
      kicker: "Web",
      title: "Browse",
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
      kicker: "Notes",
      title: "Explore",
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
          /*
            The cell, not the card, is the query container.
            A container's own rules cannot answer its own query — an element is
            never its own container — so the card would have been able to drop
            its prose at a width it could not itself lay out differently. One
            wrapper and the card can read the width it has been given.
          */
          <span key={mode.id} className="lc-home-cell">
            <button
              type="button"
              className="lc-home-card"
              data-mode={mode.id}
              aria-label={`${mode.title} — ${mode.blurb}${mode.wip ? " (work in progress)" : ""}`}
              disabled={busy}
              onClick={mode.onOpen}
            >
              {mode.wip ? <span className="lc-home-wip">(WIP)</span> : null}
              <span className="lc-home-card-icon" aria-hidden>
                {mode.live}
                {mode.icon}
              </span>
              <span className="lc-home-card-text">
                <span className="lc-home-card-kicker">{mode.kicker}</span>
                <strong className="lc-home-card-title">{mode.title}</strong>
                <span className="lc-home-card-blurb">{mode.blurb}</span>
              </span>
            </button>
          </span>
        ))}
      </div>
    </nav>
  );
}
