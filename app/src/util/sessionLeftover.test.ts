import { describe, expect, it } from "vitest";

import type { SessionSnapshot } from "../api/types";
import { leftoverAny, leftoverForDataset } from "./sessionLeftover";

function session(partial: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    started_at: 1,
    active_list: null,
    queue: [],
    problems: {},
    reveals: {},
    ...partial,
  };
}

describe("leftoverForDataset", () => {
  it("keeps kodcode pass/fail when the index is empty", () => {
    const snap = session({
      problems: {
        "kodcode/running-max": {
          state: "passed",
          passed_cases: 3,
          total_cases: 3,
          updated_at: 1,
        },
        "leetcode/two-sum": {
          state: "failed",
          passed_cases: 0,
          total_cases: 2,
          updated_at: 1,
        },
      },
      reveals: { "kodcode/running-max": 2 },
    });
    const kodcode = leftoverForDataset(snap, "kodcode");
    expect(kodcode).toEqual({ loaded: 0, passed: 1, failed: 0, reveals: 2 });
    expect(leftoverAny(kodcode)).toBe(true);
    expect(leftoverForDataset(snap, "ms-python-q")).toEqual({
      loaded: 0,
      passed: 0,
      failed: 0,
      reveals: 0,
    });
  });
});
