import { describe, expect, it } from "vitest";

import { capsuleFragDepth } from "./sdfDepth";

describe("capsuleFragDepth", () => {
  it("puts a later hop in front at a self-cross", () => {
    const early = capsuleFragDepth(8);
    const late = capsuleFragDepth(40);
    expect(late).toBeLessThan(early);
  });

  it("lets the later hop cover a joint, including its rim", () => {
    const earlier = capsuleFragDepth(11);
    const later = capsuleFragDepth(12);
    expect(later).toBeLessThan(earlier);
  });
});
