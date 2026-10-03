import { describe, expect, it } from "vitest";

import { clusterBoxes } from "./ConflictPagePreview";

describe("clusterBoxes", () => {
  it("gives a line of handwriting one box and a far note its own", () => {
    const word = (l: number) => ({ l, t: 100, r: l + 30, b: 120 });
    const clusters = clusterBoxes([word(10), word(50), word(90), { l: 400, t: 600, r: 420, b: 610 }], 18);
    expect(clusters).toEqual([
      { l: 10, t: 100, r: 120, b: 120 },
      { l: 400, t: 600, r: 420, b: 610 },
    ]);
  });

  it("joins boxes a later stroke bridges", () => {
    const clusters = clusterBoxes([
      { l: 0, t: 0, r: 10, b: 10 },
      { l: 100, t: 0, r: 110, b: 10 },
      { l: 5, t: 0, r: 105, b: 10 },
    ], 4);
    expect(clusters).toEqual([{ l: 0, t: 0, r: 110, b: 10 }]);
  });
});

describe("undecidedInk", () => {
  it("fades a stroke's own colour instead of greying it", async () => {
    const { undecidedInk } = await import("./HubConflictSplit");
    expect(undecidedInk("#d92243")).toBe("rgba(217, 34, 67, 0.45)");
    expect(undecidedInk("#fff")).toBe("rgba(255, 255, 255, 0.45)");
    expect(undecidedInk("var(--ink)")).toBe("#9ca3af");
  });
});
