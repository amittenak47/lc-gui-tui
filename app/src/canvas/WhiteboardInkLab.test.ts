import { describe, expect, it } from "vitest";

import { WhiteboardInkLab } from "./WhiteboardInkLab";
import { keepLivePaintPump, skipCommittedReplay } from "./inkLab/liveHost";

describe("WhiteboardInkLab", () => {
  it("is the board pen surface, not RasterInkLayer", () => {
    expect(WhiteboardInkLab.displayName).toBe("WhiteboardInkLab");
  });

  it("does not replay the page while the pen is down", () => {
    expect(skipCommittedReplay(true, null)).toBe(true);
  });

  it("keeps the vsync pump running while the pen is down", () => {
    expect(keepLivePaintPump(true)).toBe(true);
  });
});
