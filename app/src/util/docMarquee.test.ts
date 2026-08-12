/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import {
  MIN_BAND_PX,
  bandFromLocalPoints,
  finalizeMarquee,
  hitRectsUnder,
  scaleOf,
  unionLocalRects,
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

  it("unionLocalRects covers the outer box", () => {
    expect(unionLocalRects([])).toBeNull();
    expect(
      unionLocalRects([
        { left: 10, top: 20, width: 30, height: 10 },
        { left: 5, top: 40, width: 50, height: 8 },
      ]),
    ).toEqual({ left: 5, top: 20, width: 50, height: 28 });
  });

  it("finalizeMarquee returns hitRects for intersecting blocks", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    const p = document.createElement("p");
    p.textContent = "hello paragraph";
    p.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 40,
        width: 200,
        height: 24,
        right: 220,
        bottom: 64,
        x: 20,
        y: 40,
        toJSON() {},
      }) as DOMRect;
    body.append(p);
    document.body.append(body);

    // jsdom Range has no layout; textUnder only needs a zero box to skip.
    const rangeProto = Range.prototype as Range & {
      getBoundingClientRect: () => DOMRect;
    };
    const prev = rangeProto.getBoundingClientRect;
    rangeProto.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    try {
      const rect = { left: 10, top: 30, width: 220, height: 50 };
      const done = finalizeMarquee(body, rect, body, undefined);
      expect(done).not.toBeNull();
      expect(done!.hitRects.length).toBeGreaterThan(0);
      expect(done!.hitRects[0]).toMatchObject({
        left: 20,
        top: 40,
        width: 200,
        height: 24,
      });
      expect(done!.anchor.kind).toBe("region");
    } finally {
      rangeProto.getBoundingClientRect = prev;
    }
  });

  it("finalizeMarquee falls back to the marquee when nothing hits", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    document.body.append(body);

    const rect = { left: 10, top: 30, width: 80, height: 40 };
    const done = finalizeMarquee(body, rect, body, undefined);
    expect(done).not.toBeNull();
    expect(done!.hitRects).toEqual([rect]);
  });

  it("hitRectsUnder skips nested hit targets in favour of the outer block", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    const box = {
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      right: 100,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    figure.getBoundingClientRect = () => box;
    img.getBoundingClientRect = () => box;
    figure.append(img);
    body.append(figure);
    document.body.append(body);

    const hits = hitRectsUnder(body, body, { left: 0, top: 0, width: 120, height: 100 });
    expect(hits).toHaveLength(1);
  });
});
