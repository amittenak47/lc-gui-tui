/**
 * When a workspace's autosave tick is worth running.
 *
 * The tick is not only the write. It also walks the scene every period to
 * fingerprint it, so the tab's unsaved dot and the Sync pill can tell whether
 * the pad moved — and with autosave Off the period is one second, because that
 * dot is the only feedback there is.
 *
 * That walk is only useful to a pane someone can look at. Home keeps a
 * workspace mounted behind its overlay and parked tabs stay mounted, so every
 * pad opened in a session used to keep fingerprinting itself forever; a
 * textbook in a background tab cost main-thread time for a dot nobody could
 * see. Gate on `showing`, not `active`: the inactive half of a split is on
 * screen, and its dot still has to move.
 *
 * Stopping the interval on the way out would drop whatever the last few
 * seconds wrote, though, so parking owes one final pass — hence `finalPass`,
 * which is true exactly on the showing → parked edge and never on a workspace
 * that was already parked when it mounted.
 */

/** What the scheduling effect should do this run. */
export type AutosavePlan = {
  /** Interval period, or null when nothing should be scheduled. */
  periodMs: number | null;
  /** Run the tick once right now, because the pane is on its way out. */
  finalPass: boolean;
};

/** With autosave Off the tick still runs, just for the dot and the pill. */
const WATCH_ONLY_MS = 1000;

export function planAutosaveTick(input: {
  hasProblem: boolean;
  showing: boolean;
  /** The saved preference: 0 or less means Off. */
  autosaveMs: number;
  /** Was an interval scheduled the last time this was planned? */
  wasScheduled: boolean;
}): AutosavePlan {
  const { hasProblem, showing, autosaveMs, wasScheduled } = input;
  if (!hasProblem) return { periodMs: null, finalPass: false };
  if (!showing) return { periodMs: null, finalPass: wasScheduled };
  return { periodMs: autosaveMs > 0 ? autosaveMs : WATCH_ONLY_MS, finalPass: false };
}
