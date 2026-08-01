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
