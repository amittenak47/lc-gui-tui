import { describe, expect, it } from "vitest";

import { AI_TAB_WIDTH, aiBookTabLeft, stackAiTabTops } from "./aiBookTabs";

describe("aiBookTabLeft", () => {
  it("hangs half the tab off the right edge", () => {
    expect(aiBookTabLeft(400, 28)).toBe(400 - 14);
    expect(aiBookTabLeft(400)).toBe(400 - AI_TAB_WIDTH / 2);
  });

  it("does not go negative on a narrow page", () => {
    expect(aiBookTabLeft(10, 28)).toBe(0);
  });
});

describe("stackAiTabTops", () => {
  it("keeps isolated tabs on their passage Y", () => {
    const tops = stackAiTabTops([
      { id: "a", y: 40 },
      { id: "b", y: 200 },
    ]);
    expect(tops.get("a")).toBe(40);
    expect(tops.get("b")).toBe(200);
  });

  it("pushes overlapping tabs apart so they stay hittable", () => {
    const tops = stackAiTabTops(
      [
        { id: "a", y: 40 },
        { id: "b", y: 45 },
      ],
      20,
    );
    expect(tops.get("a")).toBe(40);
    expect(tops.get("b")).toBe(60);
  });
});
