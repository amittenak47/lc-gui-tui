/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse.
 *
 * There is no longer a "What do you want to do?" banner over the cards. The
 * header already says `choose a mode to start`, and the question was asking
 * something the four cards answer by existing.
 *
 * The grid is symmetric at every size rather than reflowing into an orphan
 * row: four modes go 4-across, then 2×2, then a rail of icon tiles. Three
 * modes (LeetCode compiled out) stay 3-across and drop straight to the rail —
 * `homeModeColumns` is what keeps the middle tier from leaving one card
 * hanging on its own line.
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
        <Glyph>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
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
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
          <path d="M13 2v6h6V9" />
          {/* A nib crossing the page corner — the mark, not the file. */}
          <path d="m20.2 11.3-6.6 6.6-2.8.8.8-2.8 6.6-6.6z" />
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
          <button
            key={mode.id}
            type="button"
            className="lc-home-card"
            data-mode={mode.id}
            aria-label={`${mode.title} — ${mode.blurb}`}
            disabled={busy}
            onClick={mode.onOpen}
          >
            <span className="lc-home-card-icon" aria-hidden>
              {mode.icon}
            </span>
            <span className="lc-home-card-text">
              <span className="lc-home-card-kicker">{mode.kicker}</span>
              <strong className="lc-home-card-title">{mode.title}</strong>
              <span className="lc-home-card-blurb">{mode.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
