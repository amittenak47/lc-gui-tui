/**
 * Shared pointer timing for hold-to-confirm and long-press menus.
 *
 * Default holds are short ({@link HOLD_MS}). Sensitive gates — offline mode and
 * hinted-solution reveal — keep the longer {@link HOLD_SENSITIVE_MS}.
 */

/** Default hold-to-confirm fill duration. */
export const HOLD_MS = 333;

/**
 * How long a press with {@link HoldButton} `onTap` stays visually empty.
 *
 * Tap-through (header pads, armed bins) must not wash fill. Fill starts after
 * this beat so a click never paints `--lc-hold`. Confirm still lands at
 * {@link HOLD_MS} from pointer down.
 */
export const HOLD_TAP_FILL_DELAY_MS = 140;

/** Longer hold for offline / reveal-solution consent. */
export const HOLD_SENSITIVE_MS = 666;

/**
 * Canvas dwell before the ink-tool wheel opens.
 *
 * Rest = planted still for {@link WHEEL_OPEN_MS} after the last drawing-like
 * hop (or after down, if there was none). Zig-zag contact noise does not
 * reset that clock. Writing = a directed stroke, a small orbit, or ongoing
 * fine marks in one patch (each drawing hop restarts the clock). No
 * interpolation. Own constant — do not reuse {@link HOLD_SENSITIVE_MS}.
 */
export const WHEEL_OPEN_MS = 280;

/**
 * Same-spot radius. A rest is that point, or jitter folding back into this
 * circle. Net past this is either a stroke or a coalesced jump.
 */
export const WHEEL_HOLD_SLOP_PX = 4;

/**
 * One sample this far from down is a stroke even with no second point.
 *
 * Below this, a single hop is bounce vs letter-start — wait for another
 * sample or the dwell timer. Zig-zag never reaches this net.
 */
export const WHEEL_HOLD_CLEAR_PX = 12;

/**
 * net / path on the raw polyline. A letter start is ~1. Jitter folds
 * back (low). Needs two move samples; one hop uses {@link WHEEL_HOLD_CLEAR_PX}.
 */
export const WHEEL_HOLD_STRAIGHTNESS = 0.6;

/**
 * |signed turning angle| of the raw polyline (radians). A bullet is a
 * small spiral — net stays in the slop circle, heading does not cancel.
 * Jitter zig-zag reverses, so this stays near 0.
 */
export const WHEEL_HOLD_WIND_RAD = Math.PI / 2;

/**
 * Two raw hops shorter than this (combined) are contact noise, not a letter.
 */
export const WHEEL_HOLD_DRAW_PATH_PX = 1.2;

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
 * After the marquee arms, any first move starts the box.
 *
 * A vertical-vs-horizontal yield used to live here so a hitch-then-flick
 * would pan rather than draw a tall band. That also meant a hold, then a
 * drag down a paragraph — the natural annotate motion — never claimed the
 * finger. Stillness of {@link SELECT_HOLD_ARM_MS} is the disambiguation;
 * keep this helper only as a documented ratio for tests.
 */
export const SELECT_HOLD_SCROLL_RATIO = 1.35;

export function selectHoldYieldsToScroll(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx) * SELECT_HOLD_SCROLL_RATIO;
}
