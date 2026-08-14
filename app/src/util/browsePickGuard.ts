/**
 * Ghost clicks after a pad menu or system file picker must not pick the
 * problem row that was under the finger.
 *
 * Closing the document/whiteboard sheet unmounts it in the same gesture that
 * opened a file. On a tablet the leftover click lands on the problem list.
 * A later `pickProblem` can also win the race and replace the pad.
 */

/** Quiet window after a pad open ends — Android often delivers a delayed click. */
export const BROWSE_PICK_QUIET_MS = 700;

export function browsePickBlocked(
  locked: boolean,
  quietUntilMs: number,
  now = Date.now(),
): boolean {
  return locked || now < quietUntilMs;
}
