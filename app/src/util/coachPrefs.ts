/**
 * Chat behaviour the student chooses, kept next to the chat rather than in
 * Settings — the Settings modal is the daemon's configuration, and whether the
 * coach gets told about a failed test run is a property of this conversation.
 */

const FORWARD_FAILURES_KEY = "lc.coach.forwardFailures.v1";

/**
 * Off by default.
 *
 * Forwarding spends a model call the moment a run goes red, and a red run is
 * often something the student already knows how to fix — a typo they are
 * halfway through correcting. Opting in means the people who want a second pair
 * of eyes on every failure get it, and nobody else pays for it by surprise.
 */
export function loadForwardFailures(): boolean {
  try {
    return localStorage.getItem(FORWARD_FAILURES_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveForwardFailures(on: boolean): void {
  try {
    localStorage.setItem(FORWARD_FAILURES_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}
