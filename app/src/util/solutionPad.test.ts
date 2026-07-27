import { describe, expect, it } from "vitest";

import { ensureCodingRoom } from "./solutionPad";

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
