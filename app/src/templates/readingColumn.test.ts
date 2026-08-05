import { describe, expect, it } from "vitest";

import {
  READING_COLUMN_MAX,
  READING_COLUMN_MIN,
  readingColumnWidth,
  regionTextInset,
  regionTextWidth,
} from "./readingColumn";

describe("readingColumnWidth", () => {
  it("fits the column to the screen so the fit lands near zoom 1", () => {
    // This is the whole point: the width-only fit divides the viewport by the
    // column, so a column near the viewport keeps scene units near CSS pixels.
    for (const viewport of [360, 412, 600, 820]) {
      const column = readingColumnWidth(viewport);
      const fitZoom = viewport / column;
      expect(fitZoom).toBeGreaterThan(1);
      expect(fitZoom).toBeLessThan(1.4);
    }
  });

  it("caps the measure so a desk does not get a desktop line", () => {
    expect(readingColumnWidth(1400)).toBe(READING_COLUMN_MAX);
    expect(readingColumnWidth(3000)).toBe(READING_COLUMN_MAX);
  });

  it("keeps a floor, so chrome cannot eat the prose", () => {
    expect(readingColumnWidth(200)).toBe(READING_COLUMN_MIN);
  });

  it("answers with the ceiling when there is no viewport to measure", () => {
    expect(readingColumnWidth(Number.NaN)).toBe(READING_COLUMN_MAX);
    expect(readingColumnWidth(0)).toBe(READING_COLUMN_MAX);
  });
});

describe("regionTextInset", () => {
  it("keeps the authored margin on a wide drawing frame", () => {
    expect(regionTextInset(3920)).toBe(36);
  });

  it("scales down rather than spending a phone's measure on margins", () => {
    const inset = regionTextInset(340);
    expect(inset).toBeLessThan(36);
    expect(regionTextWidth(340)).toBeGreaterThan(340 * 0.85);
  });
});
