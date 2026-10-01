import { expect, it } from "vitest";
import { turnCornerAt, turnCornerExclusions, turnEdgeAt } from "./corners";

const page = { left: 10, top: 40, width: 800, height: 1000 };
it("accepts full-height side strips while leaving the body and outside alone", () => {
  for (const y of [40, 300, 540, 1040]) {
    expect(turnEdgeAt(page, 74, y)).toBe("left");
    expect(turnEdgeAt(page, 746, y)).toBe("right");
    expect(turnEdgeAt(page, 410, y)).toBeNull();
  }
  expect(turnEdgeAt(page, 75, 540)).toBeNull();
  expect(turnEdgeAt(page, 9, 540)).toBeNull();
  expect(turnEdgeAt(page, 20, 39)).toBeNull();
});
it("accepts triangles at all four corners, excluding the rest of each corner square", () => {
  for (const bottom of [false, true]) for (const right of [false, true]) {
    const x = (dx: number) => right ? 810 - dx : 10 + dx;
    const y = (dy: number) => bottom ? 1040 - dy : 40 + dy;
    expect(turnCornerAt(page, x(20), y(20))).toBe(right ? "right" : "left");
    expect(turnCornerAt(page, x(60), y(60))).toBeNull();
    expect(turnCornerAt(page, x(-1), y(10))).toBeNull();
  }
  expect(turnCornerAt(page, 15, 540)).toBeNull();
  expect(turnCornerAt(page, 410, 540)).toBeNull();
});

it("keeps native exclusions near the corners and clips them to the visible board", () => {
  const rects = turnCornerExclusions(page, page);
  expect(rects).toHaveLength(24);
  expect(rects.every(r => r.y + r.height <= 136 || r.y >= 944)).toBe(true);
  const clipped = turnCornerExclusions(page, { left: 30, top: 60, width: 300, height: 400 });
  expect(clipped.length).toBeGreaterThan(0);
  expect(clipped.every(r => r.x >= 30 && r.y >= 60 && r.x + r.width <= 330 && r.y + r.height <= 460)).toBe(true);
});
