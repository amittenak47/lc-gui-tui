import { describe, expect, it } from "vitest";

import {
  PAN_FLICK_MIN,
  PAN_FRICTION,
  PAN_REST_SPEED,
  predictFlickDeltaY,
  predictFlickEndScrollY,
  simulateFlickCoastScrollY,
} from "./flickPredict";

describe("predictFlickDeltaY", () => {
  it("is zero below the flick threshold", () => {
    expect(predictFlickDeltaY(PAN_FLICK_MIN * 0.5)).toBe(0);
    expect(predictFlickDeltaY(0)).toBe(0);
  });

  it("matches the remaining exponential travel of the rAF coast", () => {
    const velY = 1.2;
    const start = -400;
    const closed = predictFlickEndScrollY(start, velY);
    const stepped = simulateFlickCoastScrollY(
      start,
      velY,
      PAN_FRICTION,
      PAN_REST_SPEED,
      PAN_FLICK_MIN,
      1,
    );
    expect(Math.abs(closed - stepped)).toBeLessThan(1);
  });

  it("signs with velocity", () => {
    expect(predictFlickDeltaY(0.8)).toBeGreaterThan(0);
    expect(predictFlickDeltaY(-0.8)).toBeLessThan(0);
    expect(predictFlickDeltaY(-0.8)).toBeCloseTo(-predictFlickDeltaY(0.8), 8);
  });
});
