/** @vitest-environment jsdom */

/**
 * The pick itself needs a real file dialog, so what is testable here is the
 * clamp — the part that decides how big a payload leaves the tablet.
 */

import { describe, expect, it } from "vitest";

import { fitWithin, PHOTO_MAX_EDGE } from "./photoAttach";

describe("fitWithin", () => {
  it("leaves a small image alone", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("clamps the longest edge and keeps the aspect ratio", () => {
    const { width, height } = fitWithin(4032, 3024);
    expect(width).toBe(PHOTO_MAX_EDGE);
    expect(height).toBe(Math.round(3024 * (PHOTO_MAX_EDGE / 4032)));
  });

  it("clamps by height on a portrait photo", () => {
    const { width, height } = fitWithin(3024, 4032);
    expect(height).toBe(PHOTO_MAX_EDGE);
    expect(width).toBe(Math.round(3024 * (PHOTO_MAX_EDGE / 4032)));
  });

  it("never scales below a single pixel", () => {
    // A 6000×3 panorama scales its short edge to 0.0008 — a canvas of height 0
    // throws on drawImage, so the floor is the difference between a thumbnail
    // and a failed attach.
    expect(fitWithin(6000, 3).height).toBe(1);
  });

  it("rounds to whole pixels", () => {
    const { width, height } = fitWithin(3333, 1777);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });

  it("survives a zero-sized image", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
