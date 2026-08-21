/**
 * Live page or frozen copy — remembered, like Reader is.
 *
 * The toggle reset to frozen every time a browser tab was opened, which meant
 * choosing the live view was a choice you had to make again on every page. That
 * is not a default so much as an opinion re-imposed.
 *
 * Stored on the device rather than per pad: it is a way of working — do I want
 * to read pages or write on them — not a fact about any one page. A pad that
 * carries marks still opens frozen whatever this says, because the marks only
 * exist on the frozen copy and showing the live page would hide them.
 */

export type WebViewMode = "live" | "frozen";

const KEY = "whiteboard.webViewMode.v1";

export const DEFAULT_WEB_VIEW_MODE: WebViewMode = "live";

export function isWebViewMode(value: unknown): value is WebViewMode {
  return value === "live" || value === "frozen";
}

export function loadWebViewMode(): WebViewMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isWebViewMode(raw) ? raw : DEFAULT_WEB_VIEW_MODE;
  } catch {
    return DEFAULT_WEB_VIEW_MODE;
  }
}

export function saveWebViewMode(mode: WebViewMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private browsing */
  }
}

/**
 * Whether a page should open live.
 *
 * Marks win over the preference. They live on the frozen copy, so opening live
 * would show a page with the reader's own annotations invisible on it — the one
 * outcome nobody wants from either setting.
 */
export function opensLive(input: {
  supported: boolean;
  hasMarks: boolean;
  preference: WebViewMode;
}): boolean {
  if (!input.supported) return false;
  if (input.hasMarks) return false;
  return input.preference === "live";
}
