import { describe, expect, it } from "vitest";

import { clampWheelAnchor, OUTER_R } from "./ColorRadial";

describe("clampWheelAnchor", () => {
  const radius = OUTER_R;
  const view = { width: 1280, height: 800 };

  it("leaves a centred swatch alone", () => {
    expect(clampWheelAnchor(640, 400, radius, view)).toEqual({ x: 640, y: 400 });
  });

  it("lifts a swatch on the bottom edge so the ring stays on screen", () => {
    const clamped = clampWheelAnchor(640, 780, radius, view);
    expect(clamped.y).toBe(view.height - radius - 8);
    expect(clamped.y + radius).toBeLessThanOrEqual(view.height);
  });

  it("nudges a swatch on the right edge inward", () => {
    const clamped = clampWheelAnchor(1270, 400, radius, view);
    expect(clamped.x).toBe(view.width - radius - 8);
  });

  it("does not park the ring above the top of the window", () => {
    const clamped = clampWheelAnchor(100, 10, radius, view);
    expect(clamped.y).toBe(radius + 8);
  });
});
