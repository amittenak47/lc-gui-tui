import { describe, expect, it } from "vitest";

import {
  appendInkPalette,
  cycleInkPaletteNext,
  cycleInkPalettePrev,
  COLORHUNT_FALLBACK_CODES,
  footnoteThemeSeed,
  normalizeInkPaletteHistory,
  paletteForMarkIndex,
  paletteFromColorHuntCode,
  remapColorToPalette,
  seedInkPaletteHistory,
  setInkPaletteSlot,
  stepFallbackPalette,
} from "./inkPaletteHistory";

describe("paletteFromColorHuntCode", () => {
  it("splits a 24-char code into four hex colours", () => {
    expect(paletteFromColorHuntCode("83e4b53ec8ac4e90a46e60a0")).toEqual([
      "#83e4b5",
      "#3ec8ac",
      "#4e90a4",
      "#6e60a0",
    ]);
  });

  it("rejects bad codes", () => {
    expect(paletteFromColorHuntCode("short")).toBeNull();
    expect(paletteFromColorHuntCode("zzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });
});

describe("ink palette history", () => {
  it("seeds from the theme swatches", () => {
    const seeded = seedInkPaletteHistory("paper");
    expect(seeded.items).toHaveLength(1);
    expect(seeded.index).toBe(0);
    expect(seeded.items[0].length).toBeGreaterThanOrEqual(4);
  });

  it("cycles forward within cache then asks for a fetch", () => {
    let history = {
      items: [
        ["#111111", "#222222", "#333333", "#444444"],
        ["#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd"],
      ],
      index: 0,
    };
    const step = cycleInkPaletteNext(history);
    expect(step.needsFetch).toBe(false);
    expect(step.history.index).toBe(1);
    const end = cycleInkPaletteNext(step.history);
    expect(end.needsFetch).toBe(true);
    expect(end.history.index).toBe(1);
  });

  it("cycles backward with wrap", () => {
    const history = {
      items: [
        ["#111111", "#222222", "#333333", "#444444"],
        ["#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd"],
      ],
      index: 0,
    };
    expect(cycleInkPalettePrev(history).index).toBe(1);
  });

  it("appends a fresh palette and reuses duplicates", () => {
    const base = {
      items: [["#111111", "#222222", "#333333", "#444444"]],
      index: 0,
    };
    const added = appendInkPalette(base, ["#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd"]);
    expect(added.items).toHaveLength(2);
    expect(added.index).toBe(1);
    const again = appendInkPalette(added, ["#AAAAAA", "#BBBBBB", "#CCCCCC", "#DDDDDD"]);
    expect(again.items).toHaveLength(2);
    expect(again.index).toBe(1);
  });

  it("edits a slot on the active palette", () => {
    const history = {
      items: [["#111111", "#222222", "#333333", "#444444"]],
      index: 0,
    };
    const next = setInkPaletteSlot(history, 1, "#ff00aa");
    expect(next.items[0][1]).toBe("#ff00aa");
  });

  it("normalizes saved blobs and falls back when empty", () => {
    expect(
      normalizeInkPaletteHistory(
        {
          items: [["#ABCDEF", "#123456", "#789abc", "#def012"]],
          index: 0,
        },
        "paper",
      ).items[0][0],
    ).toBe("#abcdef");
    expect(normalizeInkPaletteHistory(null, "paper").items).toHaveLength(1);
  });
});

describe("per-mark palettes", () => {
  it("gives successive create-order indexes different palettes", () => {
    const a = paletteForMarkIndex(0);
    const b = paletteForMarkIndex(1);
    expect(a).not.toEqual(b);
    expect(a).toHaveLength(4);
    expect(paletteForMarkIndex(COLORHUNT_FALLBACK_CODES.length)).toEqual(a);
  });

  it("seeds a new mark on the first swatch of its index", () => {
    const seed = footnoteThemeSeed(3);
    expect(seed.palette).toEqual(paletteForMarkIndex(3));
    expect(seed.color).toBe(seed.palette[0]);
  });

  it("steps the ColorHunt set without sharing a wheel", () => {
    const start = paletteForMarkIndex(0);
    const next = stepFallbackPalette(start, 1);
    const prev = stepFallbackPalette(next, -1);
    expect(next).toEqual(paletteForMarkIndex(1));
    expect(prev).toEqual(start);
  });

  it("keeps the same slot when remapping onto a new set", () => {
    const prev = ["#111111", "#222222", "#333333", "#444444"];
    const next = ["#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd"];
    expect(remapColorToPalette("#222222", prev, next)).toBe("#bbbbbb");
    expect(remapColorToPalette(undefined, prev, next)).toBe("#aaaaaa");
  });
});
