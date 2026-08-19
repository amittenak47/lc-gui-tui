/**
 * Lock toggle on a saved library row. Locked rows keep their trash hidden.
 */

export function LibraryPadlock({
  name,
  locked = false,
  disabled = false,
  onToggle,
}: {
  name: string;
  locked?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={["lc-scratch-load-lock", locked && "is-locked"].filter(Boolean).join(" ")}
      disabled={disabled}
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${name}` : `Lock ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {locked ? (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </>
        ) : (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0" />
          </>
        )}
      </svg>
    </button>
  );
}
