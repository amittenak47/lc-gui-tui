/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse, Explore.
 *
 * There is no longer a "What do you want to do?" banner over the cards. The
 * header already says `choose a mode to start`, and the question was asking
 * something the four cards answer by existing.
 *
 * The grid is symmetric at every size rather than reflowing into an orphan
 * row: an even count halves cleanly, an odd one keeps its full width and skips
 * the middle tier — `homeModeColumns` is what keeps that tier from leaving one
 * card hanging on its own line. With LeetCode compiled in that is five modes
 * (odd, so 5-across then the rail); without it, four (4, then 2×2).
 *
 * Sizing is driven by a container query on the chooser itself, not the
 * viewport, so the same collapse happens when something else takes the width.
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
                <path d="m9 8-3.5 4L9 16" />
                <path d="m15 8 3.5 4L15 16" />
                <path d="M13.4 5.5 10.6 18.5" />
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
          <path d="m20.2 11.3-6.6 6.6-2.8.8.8-2.8 6.6-6.6z" />
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
          <path d="M8 13h8" />
          <path d="M8 17h5" />
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
    <nav
      className="lc-home-chooser"
      aria-label="Choose a workspace"
      style={{
        ["--lc-home-cols" as string]: String(modes.length),
        ["--lc-home-cols-mid" as string]: String(homeModeColumns(modes.length)),
      }}
    >
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
