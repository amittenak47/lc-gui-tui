/**
 * Ask Android to stop stealing strokes from the edges of the board.
 *
 * On a gesture-navigation device the system owns a strip down each side of the
 * screen: a drag inward from the left or the right is Back. That strip is
 * exactly where the margin of a notebook is, so a downstroke that starts too
 * near the edge leaves the app instead of leaving ink — and the stroke is gone
 * with it, because the app never saw a `pointerup`.
 *
 * `setSystemGestureExclusionRects` hands those strips back. It is granted
 * grudgingly: **200dp per edge**, and asking for more is silently trimmed
 * rather than refused, so what is asked for has to be chosen rather than
 * maximised. See the plugin for how the budget is spent.
 *
 * The bottom edge is not asked for. Home is how people leave, there is no API
 * to take it, and an app that made leaving unreliable would be a worse bargain
 * than one that occasionally loses a stroke near the bottom — which the board's
 * own chrome already sits clear of.
 *
 * This module is deliberately quiet everywhere else. On desktop and in a plain
 * browser build the command resolves to zero and nothing has gone wrong.
 */

export interface ExclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How wide a strip to claim on each side, in CSS pixels.
 *
 * Comfortably wider than the system's own strip (about 20dp on most devices),
 * because what matters is not covering the strip but covering the part of the
 * page a hand writes on near the edge — and a margin is wider than a gesture.
 */
export const EDGE_STRIP_PX = 32;

let invokeLoader: Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> | null = null;

function loadInvoke() {
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then(
        (mod) => mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
      )
      .catch(() => null);
  }
  return invokeLoader;
}

/**
 * The strips to claim for a board occupying `rect`.
 *
 * Pure, so the arithmetic that decides where the writing surface ends can be
 * tested without a device. Returns nothing for a board too narrow to have
 * margins — two 32px strips on a 100px board is not a margin, it is the page.
 */
export function edgeStrips(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): ExclusionRect[] {
  if (rect.width < EDGE_STRIP_PX * 4 || rect.height <= 0) return [];
  return [
    { x: rect.left, y: rect.top, width: EDGE_STRIP_PX, height: rect.height },
    {
      x: rect.left + rect.width - EDGE_STRIP_PX,
      y: rect.top,
      width: EDGE_STRIP_PX,
      height: rect.height,
    },
  ];
}

/**
 * Claim (or with an empty list, release) the gesture strips.
 *
 * Failures are swallowed on purpose. Every caller is a resize or a mode change
 * on a surface that works perfectly well without this — losing the odd edge
 * stroke is the status quo, and an error banner about a platform affordance
 * would be worse than the thing it is reporting.
 */
export async function applyGestureExclusions(rects: ExclusionRect[]): Promise<void> {
  const invoke = await loadInvoke();
  if (!invoke) return;
  try {
    const applied = await invoke("set_gesture_exclusions", {
      rects,
      density: window.devicePixelRatio || 1,
    });
    if (import.meta.env.DEV && typeof applied === "number") {
      console.debug(`[gestureExclusion] applied ${applied} exclusion rect(s)`);
    }
  } catch {
    /* not Android, or the window has gone — either way there is nothing to do */
  }
}
