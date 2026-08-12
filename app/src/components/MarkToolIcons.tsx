/**
 * Icons shared between the drawing toolbar and footnote sub-mark controls.
 */

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
