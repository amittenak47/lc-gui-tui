/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { loadPalettePrefs, normalizePalettePrefs, savePalettePrefs, togglePaletteTag } from "./palettePref";

afterEach(() => localStorage.clear());
it("migrates the single tag and keeps All as the default", () => {
  expect(loadPalettePrefs()).toEqual({ tags: ["any"], matchAll: false, mixColours: false });
  localStorage.setItem("whiteboard.palette.tag", "neon");
  expect(loadPalettePrefs().tags).toEqual(["neon"]);
  const prefs = { tags: ["neon", "dark"] as const, matchAll: true, mixColours: true };
  savePalettePrefs({ ...prefs, tags: [...prefs.tags] });
  expect(loadPalettePrefs()).toEqual(prefs);
  expect(localStorage.getItem("whiteboard.palette.tag")).toBe("neon");
});
it("toggles a set, clears it with All, and restores All when the last tag is removed", () => {
  let prefs = normalizePalettePrefs("neon");
  prefs = togglePaletteTag(prefs, "dark"); expect(prefs.tags).toEqual(["neon", "dark"]);
  prefs = togglePaletteTag(prefs, "neon"); expect(prefs.tags).toEqual(["dark"]);
  prefs = togglePaletteTag(prefs, "dark"); expect(prefs.tags).toEqual(["any"]);
  prefs = togglePaletteTag(prefs, "neon"); expect(prefs.tags).toEqual(["neon"]);
  expect(togglePaletteTag(prefs, "any").tags).toEqual(["any"]);
});
it("rejects invalid tags, deduplicates and canonicalizes saved sets", () => {
  expect(normalizePalettePrefs({ tags: ["dark", "bad", "neon", "neon"] }).tags).toEqual(["neon", "dark"]);
  expect(normalizePalettePrefs({ tags: ["neon", "any"] }).tags).toEqual(["any"]);
  localStorage.setItem("whiteboard.palette.v1", "bad json");
  localStorage.setItem("whiteboard.palette.tag", "pastel");
  expect(loadPalettePrefs().tags).toEqual(["pastel"]);
});
