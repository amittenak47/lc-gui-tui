import { describe, expect, it } from "vitest";

import { problemKey, splitProblemKey } from "./datasetKey";

describe("problem keys", () => {
  it("round-trips a dataset and a task id", () => {
    expect(problemKey("kodcode", "running-max")).toBe("kodcode/running-max");
    expect(splitProblemKey("kodcode/running-max")).toEqual(["kodcode", "running-max"]);
  });

  /** The badge bug: `two-sum` is in three corpora and means three problems. */
  it("keeps the same slug in different problem sets apart", () => {
    expect(problemKey("leetcode", "two-sum")).not.toBe(problemKey("kodcode", "two-sum"));
  });

  it("reads a pre-datasets bare id as the default corpus", () => {
    expect(splitProblemKey("two-sum")).toEqual(["leetcode", "two-sum"]);
    // A leading slash is not a dataset name.
    expect(splitProblemKey("/two-sum")).toEqual(["leetcode", "/two-sum"]);
  });

  it("splits on the first slash only, since task ids can contain them", () => {
    expect(splitProblemKey("kodcode/some/nested-id")).toEqual(["kodcode", "some/nested-id"]);
  });
});
