/**
 * "Something has taken the whole screen."
 *
 * The live page is a native surface: it composites above every piece of HTML in
 * the app, whatever the z-index. That is why the board chrome hides itself while
 * a page is live — and it is also why Settings opened *behind* it. You could see
 * the header blur and nothing else, because the panel was there, painted over by
 * a webview the compositor puts on top.
 *
 * Nothing can be drawn above it, so the only move left is to take it away for
 * as long as the panel is up.
 *
 * Watching the DOM rather than asking each dialog to announce itself is
 * deliberate: there are a dozen of these, they come and go, and the one nobody
 * remembers to wire is the one that opens behind the page. Both class names are
 * already this app's convention for a full-screen backdrop.
 */

export const SCREEN_OVERLAY_SELECTOR = ".lc-settings-backdrop, .lc-modal-backdrop";

export function screenOverlayOpen(root: ParentNode | null = globalThis.document ?? null): boolean {
  if (!root) return false;
  return root.querySelector(SCREEN_OVERLAY_SELECTOR) != null;
}

/**
 * Report whether a full-screen overlay is up, now and whenever it changes.
 *
 * Called once immediately, so a caller mounting under an already-open dialog
 * starts from the truth. Returns an unsubscribe.
 *
 * The observer only exists while a live page does — that is the only time this
 * question has an answer anyone needs — so the cost lands in the one state
 * where the app's own DOM is mostly idle, the page being somebody else's.
 */
export function watchScreenOverlay(
  onChange: (open: boolean) => void,
  root: Document | null = globalThis.document ?? null,
): () => void {
  let last = screenOverlayOpen(root);
  onChange(last);
  if (!root?.body || typeof MutationObserver !== "function") return () => {};

  let frame: number | null = null;
  const check = () => {
    frame = null;
    const now = screenOverlayOpen(root);
    if (now === last) return;
    last = now;
    onChange(now);
  };
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16) as unknown as number;
  const cancel =
    typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

  // A dialog mounting is one burst of mutations, not one — coalesce to a frame
  // so the question is asked once however many nodes arrived.
  const observer = new MutationObserver(() => {
    if (frame != null) return;
    frame = raf(check);
  });
  observer.observe(root.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (frame != null) cancel(frame);
  };
}
