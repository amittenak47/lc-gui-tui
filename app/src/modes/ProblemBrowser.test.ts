/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { COLUMN_SORT, cycle } from "./ProblemBrowser";

describe("cycle", () => {
  it("wraps to the first option", () => {
    expect(cycle(["a", "b", "c"], "c")).toBe("a");
    expect(cycle(["a", "b", "c"], "a")).toBe("b");
  });
});

describe("COLUMN_SORT", () => {
  it("maps each header to a search sort key", () => {
    expect(COLUMN_SORT.question).toBe("question");
    expect(COLUMN_SORT.task_id).toBe("task_id");
    expect(COLUMN_SORT.difficulty).toBe("difficulty");
    expect(COLUMN_SORT.tags).toBe("tags");
    expect(COLUMN_SORT.cases).toBe("cases");
  });
});
