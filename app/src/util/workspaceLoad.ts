/**
 * Busy strings that mean a workspace / pad is still opening — not coach ask,
 * not save, not a generic wait. The header ← cancels these.
 */
export const WORKSPACE_LOAD_BUSY = [
  "loading the workspace…",
  "opening offline…",
  "opening whiteboard…",
  "opening document…",
] as const;

/**
 * What a load's `finally` should do with the shared overlay.
 *
 * `beginWorkspaceLoad` claims `inFlightGen`. A Strict Mode (or tab-close)
 * unmount bumps `currentGen` without starting a successor. The bailed load must
 * then release Home — leaving the flag for a load that never runs is the
 * black canvas + spinner.
 *
 * `defer` means a newer `beginWorkspaceLoad` already owns the chrome.
 */
export function loadChromeFate(
  loadGen: number,
  currentGen: number,
  inFlightGen: number | null,
): "finish" | "abandon" | "defer" {
  if (currentGen === loadGen) return "finish";
  if (inFlightGen === loadGen) return "abandon";
  return "defer";
}

export function isWorkspaceLoadBusy(busy: string | null): boolean {
  if (busy === null) return false;
  return (WORKSPACE_LOAD_BUSY as readonly string[]).includes(busy);
}

export function workspaceLoadHomeLabel(busy: string | null): boolean {
  return busy === "opening whiteboard…" || busy === "opening document…";
}

/**
 * The parked-split effect may drop `boardPreparing` only when nothing is
 * actually loading.
 *
 * Session restore is `userLoad: false` (no theatre) but it is still a load:
 * the chip and lined paper come back before ink shards are ingested. Clearing
 * preparing in that gap mounts the WebGL pad on an empty book.
 */
export function mayClearParkedPreparing(loadInFlight: boolean): boolean {
  return !loadInFlight;
}

/** Spinner is visible at least this long so a fast restore is not a blink. */
export const BOOT_MIN_SHOW_MS = 180;
/** Checkmark beat after the workspace snap is actually on screen. */
export const BOOT_DONE_HOLD_MS = 180;
export const BOOT_EXIT_MS = 160;
/** Home with nothing to restore may finish after this, not the old 1s theatre. */
export const BOOT_EMPTY_READY_MS = 400;
/** Dense Exam restore must not hold the splash forever. */
export const BOOT_MAX_WAIT_MS = 20_000;
/** Overlay slide away. Match `.lc-slide-in` / `.lc-slide-out`. */
export const LOAD_SLIDE_MS = 180;
/** Board fade-in after the overlay drops. Match `.lc-board-in`. */
export const LOAD_FADE_MS = 200;

/**
 * Boot splash used to run on a timer and drop while the notebook was still
 * white. Hold until a real load has finished, or until Home is idle.
 */
export function bootOverlayMayFinish(opts: {
  elapsedMs: number;
  loading: boolean;
  sawLoad: boolean;
  idleShell: boolean;
}): boolean {
  if (opts.elapsedMs < BOOT_MIN_SHOW_MS) return false;
  if (opts.loading) return false;
  if (opts.sawLoad) return true;
  if (opts.idleShell && opts.elapsedMs >= BOOT_EMPTY_READY_MS) return true;
  return opts.elapsedMs >= BOOT_MAX_WAIT_MS;
}
