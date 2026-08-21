/**
 * "The split just changed shape" — said out loud, because nothing else says it.
 *
 * Dragging the sash writes CSS variables on `<main>` and tells React only on
 * pointerup, and even then only the ratio. The two boards inside learn their
 * pane resized from a `ResizeObserver` and nothing else — no React update, no
 * `window.resize`. That is fine while the observer is prompt. It is not fine in
 * the Android WebView, which starves layout callbacks under a continuous touch
 * gesture; the same "waits for a pointer" behaviour `liveExcalidrawViewport`
 * exists to work around. The drag then ends with both panes resized and neither
 * board refitted.
 *
 * So the gesture announces itself. `move` is advisory — a board may coalesce it
 * however it likes. `settle` is the guarantee: the geometry is final, refit even
 * if you think nothing changed.
 */

export const SPLIT_RESIZE_EVENT = "lc-split-resize";

export type SplitResizePhase = "move" | "settle";

export interface SplitResizeDetail {
  phase: SplitResizePhase;
}

export function announceSplitResize(phase: SplitResizePhase): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SplitResizeDetail>(SPLIT_RESIZE_EVENT, { detail: { phase } }),
  );
}

/** The phase on a split-resize event, or null if it is not one of ours. */
export function splitResizePhase(event: Event): SplitResizePhase | null {
  const detail = (event as CustomEvent<SplitResizeDetail>).detail;
  if (!detail) return null;
  return detail.phase === "move" || detail.phase === "settle" ? detail.phase : null;
}
