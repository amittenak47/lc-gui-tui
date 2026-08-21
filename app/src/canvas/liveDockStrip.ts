/**
 * How much of a live pane the dock needs back.
 *
 * A live page is a native webview: it paints above every element of ours no
 * matter what the stacking order says, so chrome cannot be drawn over it. It can
 * only be given a strip the webview does not cover. `.lc-live-web-pane` is the
 * rectangle the webview follows, so the reservation is a `bottom` inset on that
 * box — and the inset has to be measured, because the dock is a column whose
 * height depends on what is showing. A pen toolbar with the colour wheel open is
 * several times the height of a bare Recentre button, and a fixed guess would
 * either crop the page for nothing or leave the toolbar under the webview again.
 */

/** The custom property `.lc-canvas-live-web .lc-live-web-pane` reads. */
export const DOCK_STRIP_VAR = "--lc-live-dock-strip";

/**
 * The strip a dock of this height needs.
 *
 * Rounded up: a fractional device pixel left uncovered is a sliver of toolbar
 * under the webview, which is the failure this exists to prevent. Zero means
 * zero — a collapsed or unmounted dock asks for nothing, and reserving a
 * default height for one that is not there would crop the page for no one.
 */
export function dockStrip(height: number): string {
  if (!Number.isFinite(height) || height <= 0) return "0px";
  return `${Math.ceil(height)}px`;
}

/**
 * Keep {@link DOCK_STRIP_VAR} matched to `node`'s height for as long as it is
 * mounted, and clear it afterwards.
 *
 * Returns a disposer, so this can be a React 19 callback ref straight from the
 * element that *is* the dock — no second lookup, and no stale value left behind
 * when the board unmounts.
 */
export function trackDockStrip(
  node: HTMLElement | null,
  root?: HTMLElement,
): (() => void) | undefined {
  if (!node) return undefined;
  const target = root ?? node.ownerDocument.documentElement;
  const publish = () => {
    target.style.setProperty(DOCK_STRIP_VAR, dockStrip(node.getBoundingClientRect().height));
  };
  publish();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
  observer?.observe(node);
  return () => {
    observer?.disconnect();
    target.style.removeProperty(DOCK_STRIP_VAR);
  };
}
