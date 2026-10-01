import { describe, expect, it } from "vitest";
import { flatSheet } from "./paintTurn";

describe("flatSheet", () => {
  const frame = { layout: "sheet" as const, width: 400, height: 600, bottom: false };
  /** Where the flat sheet ends at the height nearest `y`. */
  const foldAt = (flat: { x: number; y: number }[], y: number) =>
    flat.slice(1, -1).reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best)).x;

  it("folds a sheet held by its side top to bottom, leading where it is held", () => {
    const flat = flatSheet({ ...frame, corner: { x: 0, y: 270 }, restY: 270 });
    const held = foldAt(flat, 270);
    expect(held).toBeCloseTo(200, 0);
    // Above and below, the paper trails behind the hand.
    expect(foldAt(flat, 0)).toBeGreaterThan(held + 10);
    expect(foldAt(flat, 600)).toBeGreaterThan(held + 10);
  });

  it("keeps the fold straight at rest", () => {
    const flat = flatSheet({ ...frame, corner: { x: 400, y: 270 }, restY: 270 });
    expect(foldAt(flat, 0)).toBeCloseTo(400, 5);
    expect(foldAt(flat, 600)).toBeCloseTo(400, 5);
  });
});
