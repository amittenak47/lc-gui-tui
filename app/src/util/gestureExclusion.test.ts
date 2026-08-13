import { describe, expect, it } from "vitest";

import {
  edgeStrips,
  EDGE_STRIP_PX,
  EXCLUSION_BUDGET_CSS,
} from "./gestureExclusion";

const board = { left: 0, top: 0, width: 800, height: 1200 };

describe("edgeStrips", () => {
  it("claims a 200px-tall band, not the full board height", () => {
    const strips = edgeStrips(board);
    expect(strips).toHaveLength(2);
    for (const strip of strips) {
      expect(strip.width).toBe(EDGE_STRIP_PX);
      expect(strip.height).toBe(EXCLUSION_BUDGET_CSS);
    }
  });

  it("centres the band on the board when no hand position is known", () => {
    const [left] = edgeStrips(board);
    expect(left.y).toBe((board.height - EXCLUSION_BUDGET_CSS) / 2);
  });

  it("centres the band on the writing hand, clamped to the board", () => {
    const [mid] = edgeStrips(board, 400);
    expect(mid.y).toBe(400 - EXCLUSION_BUDGET_CSS / 2);

    const [top] = edgeStrips(board, 10);
    expect(top.y).toBe(0);

    const [bottom] = edgeStrips(board, 1190);
    expect(bottom.y + bottom.height).toBe(board.height);
  });

  it("puts them against the edges, not near them", () => {
    const [left, right] = edgeStrips(board);
    expect(left.x).toBe(0);
    expect(right.x + right.width).toBe(board.width);
  });

  it("rides an offset board", () => {
    const rect = { left: 40, top: 90, width: 800, height: 500 };
    const [left, right] = edgeStrips(rect);
    expect(left.x).toBe(40);
    expect(right.x + right.width).toBe(840);
    expect(left.y).toBeGreaterThanOrEqual(rect.top);
    expect(left.y + left.height).toBeLessThanOrEqual(rect.top + rect.height);
  });

  /*
   * The bottom edge is not a third strip. Home is handled by sticky immersive
   * in the plugin, not by setSystemGestureExclusionRects (no API for it).
   */
  it("never claims the bottom as a third strip", () => {
    for (const strip of edgeStrips(board)) {
      expect(strip.width).toBeLessThan(board.width);
    }
  });

  it("leaves a board too narrow to have margins alone", () => {
    expect(edgeStrips({ left: 0, top: 0, width: 100, height: 400 })).toEqual([]);
  });

  it("has nothing to claim on a board with no height", () => {
    expect(edgeStrips({ left: 0, top: 0, width: 800, height: 0 })).toEqual([]);
  });

  it("uses the full height when the board is shorter than the budget", () => {
    const short = { left: 0, top: 10, width: 800, height: 80 };
    const [left] = edgeStrips(short);
    expect(left.y).toBe(10);
    expect(left.height).toBe(80);
  });
});
