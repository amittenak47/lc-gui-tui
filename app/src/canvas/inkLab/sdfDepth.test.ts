import { describe, expect, it } from "vitest";

import { capsuleFragDepth } from "./sdfDepth";

describe("capsuleFragDepth", () => {
  const r = 10;

  it("puts a later hop in front at a self-cross", () => {
    const early = capsuleFragDepth(8, -r, r);
    const late = capsuleFragDepth(40, -r, r);
    expect(late).toBeLessThan(early);
    const lateEdge = capsuleFragDepth(40, 0, r);
    expect(lateEdge).toBeLessThan(early);
  });

  it("lets the earlier spine win a joint when the new hop is only on the rim", () => {
    const earlierCore = capsuleFragDepth(11, -r, r);
    const laterRim = capsuleFragDepth(12, 0, r);
    expect(earlierCore).toBeLessThan(laterRim);
  });

  it("keeps the new hop in front when both sit on the joint centre", () => {
    const earlier = capsuleFragDepth(11, -r, r);
    const later = capsuleFragDepth(12, -r, r);
    expect(later).toBeLessThanOrEqual(earlier);
  });
});
