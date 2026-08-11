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

  /*
   * The one case where "get out of the way" and "let me work" disagree.
   *
   * In `hidden` the only way back used to be a tap on an invisible corner, and
   * needing to find it in order to change pen colour mid-annotation is not a
   * trade anyone made knowingly.
   */
  it("softens hidden into fade while a drawing tool is up", () => {
    expect(chromeVisibility("hidden", { awake: true, annotating: true })).toEqual({
      chrome: true,
      eye: true,
    });
    // Still gets out of the way when the hand stops — it is fade, not visible.
    expect(chromeVisibility("hidden", { awake: false, annotating: true })).toEqual({
      chrome: false,
      eye: false,
    });
  });

  it("leaves the other two modes alone while annotating", () => {
    expect(chromeVisibility("visible", { awake: false, annotating: true })).toEqual({
      chrome: true,
      eye: true,
    });
    expect(chromeVisibility("fade", { awake: true, annotating: true })).toEqual({
      chrome: true,
      eye: true,
    });
  });

  it("reads a bare boolean as 'awake, not annotating'", () => {
    expect(chromeVisibility("hidden", true)).toEqual(
      chromeVisibility("hidden", { awake: true }),
    );
  });
});
