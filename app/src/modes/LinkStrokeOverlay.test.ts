import { describe, expect, it } from "vitest";

import { CHIP_HIT_RADIUS, MIN_LINK_SPAN, nearestChip, spanOf } from "./LinkStrokeOverlay";
import type { LinkChip } from "./LinkStrokeOverlay";

const chip = (id: string, x: number, y: number): LinkChip => ({
  id,
  x,
  y,
  kind: "mark",
  label: id,
});

describe("spanOf", () => {
  it("measures start to end, not path length", () => {
    // A wandering stroke that comes back where it began is not a link, however
    // far the pen actually travelled.
    expect(spanOf([{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 0, y: 0 }])).toBe(0);
    expect(spanOf([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
  });

  it("is zero for a press that never moved", () => {
    expect(spanOf([])).toBe(0);
    expect(spanOf([{ x: 5, y: 5 }])).toBe(0);
  });

  it("puts a tap that wandered under the threshold", () => {
    expect(spanOf([{ x: 0, y: 0 }, { x: 6, y: 6 }])).toBeLessThan(MIN_LINK_SPAN);
  });
});

describe("nearestChip", () => {
  it("takes the closest one inside the radius", () => {
    const chips = [chip("far", 300, 300), chip("near", 12, 12)];
    expect(nearestChip(chips, 10, 10)?.id).toBe("near");
  });

  it("lands on nothing when the pointer is over empty paper", () => {
    // Letting go in the middle of the page is a link the reader thought better
    // of, and must not attach itself to whatever was nearest on screen.
    expect(nearestChip([chip("a", 0, 0)], 500, 500)).toBeNull();
  });

  it("uses the radius as a real boundary", () => {
    const chips = [chip("a", 0, 0)];
    expect(nearestChip(chips, CHIP_HIT_RADIUS - 1, 0)?.id).toBe("a");
    expect(nearestChip(chips, CHIP_HIT_RADIUS + 1, 0)).toBeNull();
  });

  it("has nothing to offer from an empty list", () => {
    expect(nearestChip([], 0, 0)).toBeNull();
  });

  it("breaks a tie deterministically, on the first listed", () => {
    const chips = [chip("first", 10, 0), chip("second", -10, 0)];
    expect(nearestChip(chips, 0, 0)?.id).toBe("first");
  });
});
