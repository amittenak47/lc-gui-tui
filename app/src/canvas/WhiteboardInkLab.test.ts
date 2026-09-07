import { describe, expect, it } from "vitest";

import { WhiteboardInkLab } from "./WhiteboardInkLab";
import { skipCommittedReplay } from "./inkLab/liveHost";

describe("WhiteboardInkLab", () => {
  it("is the board pen surface, not RasterInkLayer", () => {
    expect(WhiteboardInkLab.displayName).toBe("WhiteboardInkLab");
  });

  it("does not replay the page while the pen is down", () => {
    expect(skipCommittedReplay(true, null)).toBe(true);
  });
});
