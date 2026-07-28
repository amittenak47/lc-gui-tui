import { describe, expect, it } from "vitest";

import type { CaseResult, TestResponse } from "../api/types";
import { formatTestReport } from "./TestResultsModal";

function caseResult(overrides: Partial<CaseResult> & { case: number }): CaseResult {
  return {
    pass: false,
    input: "nums = [2, 7]",
    expected: "[0, 1]",
    actual: null,
    error: null,
    stdout: null,
    suite: false,
    ...overrides,
  };
}

function response(overrides: Partial<TestResponse> = {}): TestResponse {
  const results = overrides.results ?? [];
  return {
    dataset: "leetcode",
    task_id: "two-sum",
    all_passed: results.every((result) => result.pass),
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    stopped_early: false,
    ...overrides,
    results,
  };
}

describe("formatTestReport", () => {
  it("names the run and stays short when everything passed", () => {
    const report = formatTestReport(
      response({ results: [caseResult({ case: 1, pass: true })] }),
      "submit",
    );
    expect(report).toContain("Submit — 1/1 passed");
    expect(report).toContain("All cases passed.");
  });

  /**
   * This text is what the coach receives, so a failure has to carry enough to
   * answer "why did case 3 fail?" without the student pasting anything.
   */
  it("carries input, expected, actual, and the error's last line", () => {
    const report = formatTestReport(
      response({
        results: [
          caseResult({ case: 1, pass: true }),
          caseResult({
            case: 2,
            input: "nums = [3, 3], target = 6",
            expected: "[0, 1]",
            actual: "[]",
            error: "Traceback (most recent call last):\n  ...\nIndexError: list index out of range",
          }),
        ],
      }),
      "run",
    );
    expect(report).toContain("Run tests — 1/2 passed");
    expect(report).toContain("case 2: nums = [3, 3], target = 6");
    expect(report).toContain("expected: [0, 1]");
    expect(report).toContain("got:      []");
    expect(report).toContain("IndexError: list index out of range");
    // Only failures are reported — a passing case is noise in a prompt.
    expect(report).not.toContain("case 1:");
  });

  it("says so when the run stopped early, so 1/12 is not read as 11 passes", () => {
    const report = formatTestReport(
      response({
        results: [caseResult({ case: 1 })],
        total: 1,
        stopped_early: true,
      }),
      "run",
    );
    expect(report).toContain("stopped at the first failure");
  });

  /** The whole report goes into a prompt, so it cannot be unbounded. */
  it("caps the failures it lists and says how many were left out", () => {
    const results = Array.from({ length: 9 }, (_, i) => caseResult({ case: i + 1 }));
    const report = formatTestReport(response({ results }), "run");
    expect(report).toContain("case 5:");
    expect(report).not.toContain("case 6:");
    expect(report).toContain("…and 4 more failing cases.");
  });

  it("labels a whole-suite failure as the suite, not as case 0", () => {
    const report = formatTestReport(
      response({
        results: [
          caseResult({
            case: 0,
            suite: true,
            input: "<full assert suite>",
            expected: "all asserts pass",
            error: "AssertionError",
          }),
        ],
      }),
      "run",
    );
    expect(report).toContain("suite: <full assert suite>");
  });
});
