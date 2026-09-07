import { describe, expect, it } from "vitest";

import { WhiteboardInkLab } from "./WhiteboardInkLab";

describe("WhiteboardInkLab", () => {
  it("is the board pen surface, not RasterInkLayer", () => {
    expect(WhiteboardInkLab.displayName).toBe("WhiteboardInkLab");
  });
});

