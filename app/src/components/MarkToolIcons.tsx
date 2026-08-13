/**
 * Icons shared between the drawing toolbar, ink wheel, and footnote sub-marks.
 */

/** Pen nib — same silhouette as the ink-wheel pen slice. */
export function PenToolIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.5 4.5 19.5 9.5 9 20H4v-5Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="m12.5 6.5 5 5"
      />
    </svg>
  );
}

/** Rubber eraser — angled block with a felt end, not a backspace key. */
export function PinkEraserIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="lc-tool-svg lc-tool-eraser"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      <path
        d="M3.8 15.2 13.2 5.8a2.3 2.3 0 0 1 3.2 0l3.8 3.8a2.3 2.3 0 0 1 0 3.2L10.8 22H6.2L3.8 19.6v-4.4Z"
        fill="#f9a8d4"
        stroke="#be185d"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path d="M3.8 15.2 10.8 22" stroke="#be185d" strokeWidth="1.35" />
      <path
        d="M6.4 17.6h7.2"
        stroke="#fff1f2"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Ink highlighter nib — same silhouette as the toolbar highlighter tool. */
export function HighlighterIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="lc-tool-svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      <path
        d="M15.5 3.5 20.5 8.5 10 19H5v-5z"
        fill="var(--lc-highlight, currentColor)"
        fillOpacity="0.42"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M4 21.2h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Straight-stroke rule — same horizontal bar as the island toolbar. */
export function StraightIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M4 12h16"
      />
    </svg>
  );
}

/** Text underline — three stems and a rule, paired with {@link HighlighterIcon}. */
export function UnderlineIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="lc-tool-svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      <path
        d="M7 4v9M12 4v12M17 4v7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M5 20h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
