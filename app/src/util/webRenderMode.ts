/**
 * How a web page should be turned into something the pad can paint.
 *
 * This used to be a decision the fetch made on the reader's behalf and then
 * threw away: try Readability, and if it returns anything at all, that is what
 * you get. The button in the address bar only ever *reported* that choice — its
 * click re-ran the identical pipeline, so pressing it on a page Readability had
 * already claimed did nothing at all, twice.
 *
 * That is fine for an article and wrong for everything else. A feed — Substack's
 * front page, a subreddit, search results — is a list of things to choose
 * between, and Readability happily flattens it into one long "article" with the
 * cards, the bylines and the boundaries gone. The extraction succeeds; the page
 * becomes unusable. Nothing in the heuristic can tell those apart reliably,
 * because the difference is what the reader came for.
 *
 * So it is a setting, and it sticks: someone who browses feeds should not have
 * to turn Reader off on every page.
 */

export type WebRenderMode = "reader" | "page";

const KEY = "whiteboard.webRenderMode.v1";

export const DEFAULT_WEB_RENDER_MODE: WebRenderMode = "reader";

export function isWebRenderMode(value: unknown): value is WebRenderMode {
  return value === "reader" || value === "page";
}

export function loadWebRenderMode(): WebRenderMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isWebRenderMode(raw) ? raw : DEFAULT_WEB_RENDER_MODE;
  } catch {
    return DEFAULT_WEB_RENDER_MODE;
  }
}

export function saveWebRenderMode(mode: WebRenderMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private browsing */
  }
}

export function otherWebRenderMode(mode: WebRenderMode): WebRenderMode {
  return mode === "reader" ? "page" : "reader";
}
