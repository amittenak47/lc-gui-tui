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

/** Long-press to open a secondary menu (scratchpad load, coach message). */
export const LONG_PRESS_MS = 580;

/**
 * Finger travel before a pending hold-to-select yields to scroll.
 *
 * Board's reading pan and DocSelectionLayer must share this: if the pan arms
 * earlier (e.g. 3px), a sideways drag on a wide code block scrolls / rubber-
 * bands the page and never becomes a same-line selection.
 */
export const SELECT_HOLD_SLOP_PX = 10;
