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
