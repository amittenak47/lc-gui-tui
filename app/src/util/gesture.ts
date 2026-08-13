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
 * Shorter than the old 667ms rest. Writing is gated by
 * {@link WHEEL_HOLD_SLOP_PX}: the first move off the down-spot cancels the
 * timer and never re-arms for that pointer. Own constant — do not reuse
 * {@link HOLD_SENSITIVE_MS}.
 */
export const WHEEL_OPEN_MS = 280;

/**
 * Finger travel that turns a pending wheel dwell into ink.
 *
 * Tighter than {@link SELECT_HOLD_SLOP_PX}: cursive leaves this radius on the
 * first real stroke sample, so the dwell check runs at most once per down.
 */
export const WHEEL_HOLD_SLOP_PX = 8;

/** Long-press to open a secondary menu (scratchpad load, coach message). */
export const LONG_PRESS_MS = 580;

/**
 * Stillness before a document hold-to-marquee claims the finger.
 *
 * Capture + `claimSelectionGesture` run here so Android's native long-press
 * (~400–500ms) cannot `pointercancel` the pointer before the box arms. A move
 * after this pause is the marquee drag, not a pan. Immediate travel still
 * yields to scroll / native text select via {@link SELECT_HOLD_SLOP_PX}.
 */
export const SELECT_HOLD_ARM_MS = 140;

/**
 * Finger travel before a pending hold-to-select yields to scroll.
 *
 * Board's reading pan and DocSelectionLayer must share this: if the pan arms
 * earlier (e.g. 3px), a sideways drag on a wide code block scrolls / rubber-
 * bands the page and never becomes a same-line selection.
 */
export const SELECT_HOLD_SLOP_PX = 16;
