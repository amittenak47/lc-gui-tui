import { describe, expect, it } from "vitest";

import { CODE_LABEL_RESERVE, codeFrameHeightForSource, ensureCodingRoom } from "./solutionPad";

describe("ensureCodingRoom", () => {
  it("appends blank lines after a function stub", () => {
    const source = [
      "class Solution:",
      "    def isOneBitCharacter(self, bits: List[int]) -> bool:",
    ].join("\n");
    const padded = ensureCodingRoom(source, 5);
    expect(padded.startsWith(source)).toBe(true);
    expect(padded.endsWith("\n\n\n\n\n")).toBe(true);
  });

  it("trims existing trailing whitespace before padding", () => {
    const padded = ensureCodingRoom("def f():\n    pass\n\n\n", 3);
    expect(padded).toBe("def f():\n    pass\n\n\n\n");
  });
});

describe("codeFrameHeightForSource", () => {
  it("grows with line count above the region floor", () => {
    const short = codeFrameHeightForSource("def f():\n    pass\n");
    const long = codeFrameHeightForSource(Array.from({ length: 80 }, () => "x = 1").join("\n"));
    expect(long).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(560);
  });

  it("reserves space for the CODE label above Monaco", () => {
    const height = codeFrameHeightForSource("def f():\n    pass\n");
    expect(height).toBeGreaterThanOrEqual(CODE_LABEL_RESERVE + 22 * 3);
  });
});
