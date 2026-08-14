/**
 * Shared pointer timing for hold-to-confirm and long-press menus.
 *
 * Default holds are short ({@link HOLD_MS}). Sensitive gates — offline mode and
 * hinted-solution reveal — keep the longer {@link HOLD_SENSITIVE_MS}.
 */

/** Default hold-to-confirm fill duration. */
export const HOLD_MS = 333;

/** Longer hold for offline / reveal-solution consent. */
export const HOLD_SENSITIVE_MS = 666;

/**
 * Canvas dwell before the ink-tool wheel opens.
 *
 * Rest = pointer down, staying on the spot ({@link WHEEL_HOLD_SLOP_PX} of
 * jitter). Writing = a directed stroke: displacement past that radius, or
 * cumulative path {@link WHEEL_HOLD_PATH_PX} even if the nib has not left
 * the circle. Own constant — do not reuse {@link HOLD_SENSITIVE_MS}.
 */
export const WHEEL_OPEN_MS = 280;

/**
 * Rest radius from the down-spot. Contact noise is 1–3 CSS px; anything
 * larger is the start of a stroke, not a dwell.
 */
export const WHEEL_HOLD_SLOP_PX = 4;

/**
 * Cumulative path inside the rest circle that still counts as writing.
 *
 * A letter can wander without ever sitting 4px from origin. Jitter wiggles
 * in place and stays under this; a stroke does not.
 */
export const WHEEL_HOLD_PATH_PX = 8;

/** Long-press to open a secondary menu (scratchpad load, coach message). */
export const LONG_PRESS_MS = 580;

/**
 * Stillness before a document hold-to-marquee claims the finger.
 *
 * Capture + `claimSelectionGesture` run here so Android's native long-press
 * (~400–500ms) cannot `pointercancel` the pointer before the box arms. 140ms
 * was short enough that a scroll hitch looked like a hold. 260ms still beats
 * native select; a first move that is mostly vertical yields back to pan.
 */
export const SELECT_HOLD_ARM_MS = 260;

/**
 * Finger travel before a pending hold-to-select yields to scroll.
 *
 * Board's reading pan and DocSelectionLayer must share this: if the pan arms
 * earlier (e.g. 3px), a sideways drag on a wide code block scrolls / rubber-
 * bands the page and never becomes a same-line selection.
 */
export const SELECT_HOLD_SLOP_PX = 16;

/**
 * After the marquee arms, a first move this much more vertical than horizontal
 * is a reading pan, not a box. Horizontal / diagonal still marquees.
 */
export const SELECT_HOLD_SCROLL_RATIO = 1.35;

export function selectHoldYieldsToScroll(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx) * SELECT_HOLD_SCROLL_RATIO;
}
