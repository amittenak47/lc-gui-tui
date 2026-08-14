/**
 * Chat behaviour the student chooses, kept next to the chat rather than in
 * Settings — the Settings modal is the daemon's configuration, and whether the
 * agent gets told about a failed test run is a property of this conversation.
 */

const FORWARD_FAILURES_KEY = "whiteboard.agent.forwardFailures.v1";
const LEGACY_FORWARD_FAILURES_KEYS = ["whiteboard.coach.forwardFailures.v1"];

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
    const current = localStorage.getItem(FORWARD_FAILURES_KEY);
    if (current != null) return current === "1";
    for (const old of LEGACY_FORWARD_FAILURES_KEYS) {
      const value = localStorage.getItem(old);
      if (value != null) return value === "1";
    }
  } catch {
    return false;
  }
  return false;
}

export function saveForwardFailures(on: boolean): void {
  try {
    localStorage.setItem(FORWARD_FAILURES_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}
