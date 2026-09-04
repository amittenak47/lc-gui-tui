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
 */

import type { ReactNode } from "react";

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
            icon: (
              <Glyph>
                <path className="lc-home-bra-l" d="m9 8-3.5 4L9 16" />
                <path className="lc-home-bra-r" d="m15 8 3.5 4L15 16" />
                <path className="lc-home-slash" d="M13.4 5.5 10.6 18.5" />
                <g
                  className="lc-home-code-ipsum"
                  fill="currentColor"
                  stroke="none"
                >
                  <text
                    x="12"
                    y="8.6"
                    textAnchor="middle"
                    fontSize="3.05"
                    fontFamily='ui-monospace, "SF Mono", Menlo, Consolas, monospace'
                  >
                    fn ipsum() {"{"}
                  </text>
                  <text
                    x="12"
                    y="12.4"
                    textAnchor="middle"
                    fontSize="3.05"
                    fontFamily='ui-monospace, "SF Mono", Menlo, Consolas, monospace'
                  >
                    let dolor=0;
                  </text>
                  <text
                    x="12"
                    y="16.2"
                    textAnchor="middle"
                    fontSize="3.05"
                    fontFamily='ui-monospace, "SF Mono", Menlo, Consolas, monospace'
                  >
                    sit(amet);
                  </text>
                  <text
                    x="12"
                    y="20"
                    textAnchor="middle"
                    fontSize="3.05"
                    fontFamily='ui-monospace, "SF Mono", Menlo, Consolas, monospace'
                  >
                    {"}"}
                  </text>
                </g>
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
        // The nib, because this is the blank page you draw on. Annotate takes
        // the ruled sheet: it is the one that arrives already written.
        <Glyph>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
          <path d="M13 2v6h6V9" />
          <path className="lc-home-ink-1" d="M6.8 8.2c1.6.8 3.2.2 4.8.6" />
          <path className="lc-home-ink-2" d="M6.8 11.4c2.2-.7 3.4 1 5.2.4" />
          <path className="lc-home-ink-3" d="M6.8 14.6c1.4.9 2.8-.3 4.4.5" />
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
          <path className="lc-home-rule-1" d="M8 11h8" />
          <path className="lc-home-rule-2" d="M8 14h7" />
          <path className="lc-home-rule-3" d="M8 17h8" />
          <path className="lc-home-rule-4" d="M8 20h5" />
        </Glyph>
      ),
      onOpen: onAnnotate,
    },
    {
      id: "browse",
      kicker: "Web",
      title: "Browse",
      blurb: "Open a page, then write straight onto the snapshot.",
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
      icon: (
        // A hub with satellites — the same idea as the graph it opens, drawn
        // at the weight of the other four glyphs. The star field that animates
        // on it is CSS (`.lc-home-card-stars`), not more paths here.
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
              aria-label={`${mode.title} — ${mode.blurb}`}
              disabled={busy}
              onClick={mode.onOpen}
            >
              <span
                className={
                  mode.id === "explore"
                    ? "lc-home-card-icon lc-home-card-stars"
                    : "lc-home-card-icon"
                }
                aria-hidden
              >
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
