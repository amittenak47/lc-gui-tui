import { describe, expect, it } from "vitest";

import { edgeStrips, EDGE_STRIP_PX } from "./gestureExclusion";

const board = { left: 0, top: 0, width: 800, height: 1200 };

describe("edgeStrips", () => {
  it("claims a strip down each side, the full height of the board", () => {
    const strips = edgeStrips(board);
    expect(strips).toHaveLength(2);
    for (const strip of strips) {
      expect(strip.width).toBe(EDGE_STRIP_PX);
      expect(strip.height).toBe(board.height);
      expect(strip.y).toBe(board.top);
    }
  });

  it("puts them against the edges, not near them", () => {
    const [left, right] = edgeStrips(board);
    expect(left.x).toBe(0);
    expect(right.x + right.width).toBe(board.width);
  });

  it("rides an offset board", () => {
    const [left, right] = edgeStrips({ left: 40, top: 90, width: 800, height: 500 });
    expect(left.x).toBe(40);
    expect(left.y).toBe(90);
    expect(right.x + right.width).toBe(840);
  });

  /*
   * The bottom edge is deliberately absent. Home is how people leave, there is
   * no API to take it, and an app that made leaving unreliable would be a worse
   * bargain than one that occasionally loses a stroke near the bottom.
   */
  it("never claims the bottom", () => {
    for (const strip of edgeStrips(board)) {
      expect(strip.width).toBeLessThan(board.width);
    }
  });

  it("leaves a board too narrow to have margins alone", () => {
    // Two 32px strips on a 100px board is not a margin, it is the page.
    expect(edgeStrips({ left: 0, top: 0, width: 100, height: 400 })).toEqual([]);
  });

  it("has nothing to claim on a board with no height", () => {
    expect(edgeStrips({ left: 0, top: 0, width: 800, height: 0 })).toEqual([]);
  });
});
