/**
 * Header Home control — a small house with the "lc" mark inside.
 *
 * The old wordmark spent a lot of header on a name the window title already
 * says. A house is the same landmark every app uses for "back to the start",
 * and the letters stay Helvetica Neue so it still reads as ours.
 */

export function BrandHome() {
  return (
    <span className="lc-brand-mark" aria-hidden>
      <svg className="lc-brand-house" viewBox="0 0 36 32" fill="none">
        <path
          className="lc-brand-chimney"
          d="M24.5 8.5 V4.5 h3.2 V10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="lc-brand-puff"
          d="M27.2 3.2c.6-.8 1.8-.9 2.4-.2"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <path
          className="lc-brand-roof"
          d="M4.5 15.5 18 4.2 31.5 15.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="lc-brand-body"
          d="M7.2 15.2 h21.6 v12.4 a1.6 1.6 0 0 1 -1.6 1.6 H8.8 a1.6 1.6 0 0 1 -1.6 -1.6 z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <text className="lc-brand-letters" x="18" y="25.2" textAnchor="middle">
          lc
        </text>
      </svg>
    </span>
  );
}
