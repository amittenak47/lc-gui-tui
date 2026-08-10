import { describe, expect, it } from "vitest";

import {
  chromeModeLabel,
  chromeVisibility,
  isChromeMode,
  nextChromeMode,
  type ChromeMode,
} from "./chromeVisibility";

describe("chrome modes", () => {
  it("cycles visible → fade → hidden → visible", () => {
    expect(nextChromeMode("visible")).toBe("fade");
    expect(nextChromeMode("fade")).toBe("hidden");
    expect(nextChromeMode("hidden")).toBe("visible");
  });

  it("names each mode for the reader", () => {
    for (const mode of ["visible", "fade", "hidden"] as ChromeMode[]) {
      expect(chromeModeLabel(mode).length).toBeGreaterThan(0);
    }
  });

  it("rejects a stored value that is not a mode", () => {
    expect(isChromeMode("visible")).toBe(true);
    expect(isChromeMode("true")).toBe(false);
    expect(isChromeMode(null)).toBe(false);
  });
});

describe("chromeVisibility", () => {
  it("keeps everything on screen in visible, idle or not", () => {
    expect(chromeVisibility("visible", true)).toEqual({ chrome: true, eye: true });
    expect(chromeVisibility("visible", false)).toEqual({ chrome: true, eye: true });
  });

  it("takes the eye with the rest when fade goes quiet", () => {
    // The old boolean left the eye behind, which is exactly the button the
    // reader asked to get out of the way.
    expect(chromeVisibility("fade", true)).toEqual({ chrome: true, eye: true });
    expect(chromeVisibility("fade", false)).toEqual({ chrome: false, eye: false });
  });

  it("gives hidden back the eye alone, never the controls", () => {
    expect(chromeVisibility("hidden", false)).toEqual({ chrome: false, eye: false });
    expect(chromeVisibility("hidden", true)).toEqual({ chrome: false, eye: true });
  });
});
