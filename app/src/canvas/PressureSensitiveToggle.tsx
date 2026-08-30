export interface PressureSensitiveToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

/** Toggle stylus pressure for ink fullness (tip width stays mostly fixed). */
export function PressureSensitiveToggle({ enabled, onChange }: PressureSensitiveToggleProps) {
  return (
    <button
      type="button"
      className={
        enabled
          ? "lc-tool lc-tool-mini lc-tool-active lc-pressure-toggle"
          : "lc-tool lc-tool-mini lc-pressure-toggle"
      }
      aria-label={
        enabled
          ? "Pressure sensitive on: stylus changes ink darkness, not width"
          : "Pressure sensitive off"
      }
      title={
        enabled
          ? "Harder press = darker ink, not a fatter line"
          : "Turn on stylus pressure (darkness, not width)"
      }
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
    >
      <PressureIcon />
    </button>
  );
}

function PressureIcon() {
  return (
    <svg
      className="lc-pressure-icon"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden
    >
      <path
        d="M10 2v3M6.5 4.2l2.1 2.1M13.5 4.2l-2.1 2.1M4 10h3M13 10h3M6.5 15.8l2.1-2.1M13.5 15.8l-2.1-2.1M10 15v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" />
    </svg>
  );
}
