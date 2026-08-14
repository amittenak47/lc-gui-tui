import { describe, expect, it } from "vitest";

import {
  thumbWindow,
  trimThumbCache,
} from "./pdfFilm";

describe("thumbWindow", () => {
  it("keeps a radius around the current page", () => {
    expect(thumbWindow(10, 60, [], 2)).toEqual([8, 9, 10, 11, 12]);
  });

  it("stops at the first page", () => {
    expect(thumbWindow(1, 60, [], 2)).toEqual([1, 2, 3]);
  });

  it("stops at the last page", () => {
    expect(thumbWindow(60, 60, [], 2)).toEqual([58, 59, 60]);
  });

  it("unions cells already on the strip", () => {
    expect(thumbWindow(10, 60, [40, 41], 1)).toEqual([9, 10, 11, 40, 41]);
  });

  it("ignores pages outside the document", () => {
    expect(thumbWindow(2, 3, [0, 99], 1)).toEqual([1, 2, 3]);
  });
});

describe("trimThumbCache", () => {
  it("keeps thumbs nearest the current page", () => {
    const cache = new Map([
      [1, "a"],
      [50, "b"],
      [51, "c"],
    ]);
    const next = trimThumbCache(cache, 50, [], 2);
    expect([...next.keys()]).toEqual([50, 51]);
  });

  it("prefers pinned keys over nearer unpinned ones", () => {
    const cache = new Map([
      [1, "a"],
      [50, "b"],
      [51, "c"],
    ]);
    const next = trimThumbCache(cache, 50, [1], 2);
    expect(next.has(1)).toBe(true);
    expect(next.has(50)).toBe(true);
    expect(next.has(51)).toBe(false);
  });
});
