import { expect, it } from "vitest";
import { COLORHUNT_FALLBACK_CODES, paletteFromColorHuntCode } from "./inkPaletteHistory";
import { MIX_MIN_CONTRAST, MIX_MIN_DELTA_E, mixInkPalette, paletteContrast, paletteDeltaE } from "./paletteMix";

const pool = COLORHUNT_FALLBACK_CODES.map(code => paletteFromColorHuntCode(code)!);
it("uses sRGB contrast and a perceptual distance", () => {
  expect(paletteContrast("#000000", "#ffffff")).toBeCloseTo(21, 6);
  expect(paletteContrast("#ff0000", "#ffffff")).toBeCloseTo(3.998, 2);
  expect(paletteDeltaE("#ff0000", "#ff0000")).toBe(0);
  expect(paletteDeltaE("#ff0000", "#00ff00")).toBeGreaterThan(100);
  expect(paletteDeltaE("#112233", "#112234")).toBeLessThan(1);
});
it("makes deterministic, distinct, readable mixes on light, tinted and dark paper", () => {
  for (const paper of ["#ffffff", "#0a0a0b", "#808080", "#fff5e5", "#e6e6fa"]) {
    for (const seed of [0, 1, 17, 243, 123456789]) {
      const mixed = mixInkPalette(pool, paper, seed)!;
      expect(mixed).toHaveLength(4);
      expect(mixInkPalette(pool, paper, seed)).toEqual(mixed);
      for (const hex of mixed) {
        expect(hex).toMatch(/^#[a-f\d]{6}$/);
        expect(paletteContrast(hex, paper)).toBeGreaterThanOrEqual(MIX_MIN_CONTRAST);
      }
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        expect(paletteDeltaE(mixed[i]!, mixed[j]!)).toBeGreaterThanOrEqual(MIX_MIN_DELTA_E);
      }
    }
  }
});
it("returns no mix when constraints cannot be satisfied and skips prior mixes", () => {
  expect(mixInkPalette([["#fafafa", "#ffffff", "#fefefe", "#fdfdfd"]], "#ffffff", 7)).toBeNull();
  const first = mixInkPalette(pool, "#ffffff", 7)!;
  expect(mixInkPalette(pool, "#ffffff", 7, { seen: new Set([first.join(",")]) })).not.toEqual(first);
});
