import { describe, expect, it } from "vitest";

import {
  cycleSortKey,
  formatSort,
  parseSort,
  toggleColumnSort,
} from "./browseSort";

describe("parseSort", () => {
  it("defaults task_id to ascending and cases to descending", () => {
    expect(parseSort(undefined)).toEqual({ key: "task_id", desc: false });
    expect(parseSort("question")).toEqual({ key: "question", desc: false });
    expect(parseSort("cases")).toEqual({ key: "cases", desc: true });
  });

  it("honors :desc, :asc, and a leading minus", () => {
    expect(parseSort("question:desc")).toEqual({ key: "question", desc: true });
    expect(parseSort("-question")).toEqual({ key: "question", desc: true });
    expect(parseSort("cases:asc")).toEqual({ key: "cases", desc: false });
  });
});

describe("toggleColumnSort", () => {
  it("switches to a new column at that column's default direction", () => {
    expect(toggleColumnSort("task_id", "question")).toBe("question");
    expect(toggleColumnSort("task_id", "cases")).toBe("cases");
  });

  it("flips direction when the same column is clicked again", () => {
    expect(toggleColumnSort("question", "question")).toBe("question:desc");
    expect(toggleColumnSort("question:desc", "question")).toBe("question");
    expect(toggleColumnSort("cases", "cases")).toBe("cases:asc");
    expect(toggleColumnSort("cases:asc", "cases")).toBe("cases");
  });
});

describe("cycleSortKey", () => {
  it("walks keys and resets each to its default direction", () => {
    expect(cycleSortKey("task_id")).toBe("question");
    expect(cycleSortKey("question:desc")).toBe("difficulty");
    expect(cycleSortKey("difficulty")).toBe("cases");
    expect(cycleSortKey("cases")).toBe("tags");
    expect(cycleSortKey("tags")).toBe("task_id");
  });
});

describe("formatSort", () => {
  it("omits the suffix when it matches the default", () => {
    expect(formatSort("question", false)).toBe("question");
    expect(formatSort("cases", true)).toBe("cases");
    expect(formatSort("cases", false)).toBe("cases:asc");
  });
});
