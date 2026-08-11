/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import {
  MIN_BAND_PX,
  bandFromLocalPoints,
  scaleOf,
  viewportToLocal,
} from "./docMarquee";

describe("docMarquee", () => {
  it("bandFromLocalPoints floors height in screen pixels", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 100 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    const band = bandFromLocalPoints(body, { x: 10, y: 10 }, { x: 40, y: 12 });
    expect(band.left).toBe(10);
    expect(band.top).toBe(10);
    expect(band.width).toBe(30);
    // |12-10|=2 local; floor is MIN_BAND_PX / scale (scale=1) → 14
    expect(band.height).toBe(MIN_BAND_PX / scaleOf(body));
  });

  it("viewportToLocal divides by camera scale", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 200 });
    body.getBoundingClientRect = () =>
      ({
        left: 50,
        top: 20,
        width: 100, // rendered half of layout → scale 0.5
        height: 80,
        right: 150,
        bottom: 100,
        x: 50,
        y: 20,
        toJSON() {},
      }) as DOMRect;

    const local = viewportToLocal(body, 50 + 50, 20 + 40);
    expect(local.x).toBeCloseTo(100);
    expect(local.y).toBeCloseTo(80);
  });
});
