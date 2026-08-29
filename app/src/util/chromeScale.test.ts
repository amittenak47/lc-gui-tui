/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import {
  applyInkChromeScale,
  CHROME_SCALE_VAR,
  inkChromeScale,
  SPLIT_CHROME_SCALE,
} from "./chromeScale";

describe("inkChromeScale", () => {
  it("is full size with one pane", () => {
    expect(inkChromeScale(false)).toBe(1);
  });

  it("takes a fifth to a third off in a split", () => {
    // The ask was 20–30%; anything outside that is a different design.
    expect(inkChromeScale(true)).toBeGreaterThanOrEqual(0.7);
    expect(inkChromeScale(true)).toBeLessThanOrEqual(0.8);
    expect(inkChromeScale(true)).toBe(SPLIT_CHROME_SCALE);
  });
});

describe("applyInkChromeScale", () => {
  it("publishes the scale on the root a portalled surface can see", () => {
    const root = document.createElement("div");
    applyInkChromeScale(root, true);
    expect(root.style.getPropertyValue(CHROME_SCALE_VAR)).toBe(String(SPLIT_CHROME_SCALE));
  });

  it("takes the property away rather than writing 1", () => {
    const root = document.createElement("div");
    applyInkChromeScale(root, true);
    applyInkChromeScale(root, false);
    expect(root.style.getPropertyValue(CHROME_SCALE_VAR)).toBe("");
  });

  it("survives being handed no root", () => {
    expect(() => applyInkChromeScale(null, true)).not.toThrow();
  });
});
