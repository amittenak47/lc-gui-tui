import { describe, expect, it } from "vitest";

import { WhiteboardInkLab } from "./WhiteboardInkLab";
import { keepLivePaintPump, skipCommittedReplay } from "./inkLab/liveHost";
import { shouldCompositeLive } from "./inkLab/displayHz";

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

  it("skips empty composites and caps 90Hz presents at every other vsync", () => {
    expect(shouldCompositeLive(false, false, 0, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 1, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 0, 2)).toBe(true);
    expect(shouldCompositeLive(false, true, 0, 2)).toBe(true);
  });
});
