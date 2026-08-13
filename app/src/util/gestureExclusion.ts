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
 * maximised. CSS pixels ≈ dp here, so the strip is {@link EXCLUSION_BUDGET_CSS}
 * tall, centred on the writing hand (or the middle of the board before the
 * first stroke). See the plugin for how leftover height is spent if a caller
 * still sends a taller rect.
 *
 * Home has no exclusion API. {@link setDrawingImmersive} hides the navigation
 * bar with swipe-to-show while a drawing tool is up — first swipe reveals
 * chrome, second swipe (bar visible) still leaves. Reading mode turns it off.
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
 * Comfortably wider than the system's own strip (about 20–40dp on most
 * devices), because what matters is not covering the strip but covering the
 * part of the page a hand writes on near the edge.
 */
export const EDGE_STRIP_PX = 48;

/**
 * Android's per-edge exclusion budget, in CSS pixels (≈ dp).
 *
 * Asking for the full board height is how the old path spent the budget on
 * the top of the page — which is not where a stroke on a tall tablet lands.
 */
export const EXCLUSION_BUDGET_CSS = 200;

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
 * margins — two 48px strips on a 100px board is not a margin, it is the page.
 *
 * `focusY` (viewport CSS px) centres the 200px budget on the writing hand.
 * Without it the band sits in the middle of the board.
 */
export function edgeStrips(
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  },
  focusY?: number | null,
): ExclusionRect[] {
  if (rect.width < EDGE_STRIP_PX * 4 || rect.height <= 0) return [];
  const height = Math.min(rect.height, EXCLUSION_BUDGET_CSS);
  const minTop = rect.top;
  const maxTop = rect.top + rect.height - height;
  let top = rect.top + (rect.height - height) / 2;
  if (typeof focusY === "number" && Number.isFinite(focusY)) {
    top = focusY - height / 2;
  }
  top = Math.min(maxTop, Math.max(minTop, top));
  return [
    { x: rect.left, y: top, width: EDGE_STRIP_PX, height },
    {
      x: rect.left + rect.width - EDGE_STRIP_PX,
      y: top,
      width: EDGE_STRIP_PX,
      height,
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

/** Sticky-immersive nav bar on, or restore the bars for reading. */
export async function setDrawingImmersive(enabled: boolean): Promise<void> {
  const invoke = await loadInvoke();
  if (!invoke) return;
  try {
    await invoke("set_drawing_immersive", { enabled });
  } catch {
    /* desktop, or the plugin is missing from this APK */
  }
}
