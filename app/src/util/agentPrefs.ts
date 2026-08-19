/**
 * Whether a failed test run should call the agent, and how.
 *
 * The Tests card always lands in chat. This only gates `askAgent`.
 */

const FORWARD_MODE_KEY = "whiteboard.agent.testForward.v1";
const FORWARD_FAILURES_KEY = "whiteboard.agent.forwardFailures.v1";
const LEGACY_FORWARD_FAILURES_KEYS = ["whiteboard.coach.forwardFailures.v1"];
const REASONING_KEY = "whiteboard.agent.reasoning.v1";

export type TestForwardMode = "wait" | "whole-run" | "per-case";

/**
 * Default Wait: a red run is often a typo already being fixed.
 */
export function loadTestForwardMode(): TestForwardMode {
  try {
    const current = localStorage.getItem(FORWARD_MODE_KEY);
    if (current === "wait" || current === "whole-run" || current === "per-case") {
      return current;
    }
    const legacy = localStorage.getItem(FORWARD_FAILURES_KEY);
    if (legacy === "1") return "whole-run";
    if (legacy === "0") return "wait";
    for (const old of LEGACY_FORWARD_FAILURES_KEYS) {
      const value = localStorage.getItem(old);
      if (value === "1") return "whole-run";
      if (value === "0") return "wait";
    }
  } catch {
    return "wait";
  }
  return "wait";
}

export function saveTestForwardMode(mode: TestForwardMode): void {
  try {
    localStorage.setItem(FORWARD_MODE_KEY, mode);
    localStorage.setItem(FORWARD_FAILURES_KEY, mode === "wait" ? "0" : "1");
  } catch {
    /* private browsing */
  }
}

/** @deprecated use loadTestForwardMode */
export function loadForwardFailures(): boolean {
  return loadTestForwardMode() !== "wait";
}

/** @deprecated use saveTestForwardMode */
export function saveForwardFailures(on: boolean): void {
  saveTestForwardMode(on ? "whole-run" : "wait");
}

/** Sticky composer flag: ask the model to think out loud. Default on. */
export function loadAgentReasoning(): boolean {
  try {
    const value = localStorage.getItem(REASONING_KEY);
    if (value === "0") return false;
    if (value === "1") return true;
  } catch {
    return true;
  }
  return true;
}

export function saveAgentReasoning(on: boolean): void {
  try {
    localStorage.setItem(REASONING_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}
