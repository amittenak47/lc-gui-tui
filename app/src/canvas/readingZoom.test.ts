import { describe, expect, it } from "vitest";
import { readingZoomSpan } from "./readingZoom";
const pages = Array.from({ length: 1000 }, (_, i) => ({ pageId: i + 1, minY: i * 820, maxY: i * 820 + 800 }));
describe("pinch page scope", () => {
  it("uses one page when reading inside it", () => {
    expect(readingZoomSpan(pages, 840, 1450, 1100)).toEqual({ minY: 820, maxY: 1620 });
  });
  it("keeps both pages when the viewport crosses their boundary", () => {
    expect(readingZoomSpan(pages, 1400, 1900, 1650)).toEqual({ minY: 820, maxY: 2440 });
  });
  it("never expands to a whole book when starting zoomed far out", () => {
    const span = readingZoomSpan(pages, 0, 800000, 410100)!;
    expect(span.maxY - span.minY).toBe(1620);
    expect(span.minY).toBeLessThanOrEqual(410100);
    expect(span.maxY).toBeGreaterThan(410100);
  });
  it("does not pull a neighbour into a viewport exactly on the page boundary", () => {
    expect(readingZoomSpan(pages, 820, 1620, 1100)).toEqual({ minY: 820, maxY: 1620 });
    expect(readingZoomSpan([], 0, 100, 50)).toBeNull();
  });
});
