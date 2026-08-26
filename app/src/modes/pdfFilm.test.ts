import { describe, expect, it, vi } from "vitest";

import {
  loadPdfSpreadPref,
  peekPdfReadingFrames,
  publishPdfFilmCurrent,
  publishPdfFilmFromCamera,
  resetPdfFilmCurrent,
  resetPdfReadingFrames,
  savePdfSpreadPref,
  setPdfReadingFrames,
  subscribePdfFilmCurrent,
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

describe("pdf spread pref", () => {
  it("is off by default and persists per document hash", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    expect(loadPdfSpreadPref("hash-a")).toBe(false);
    savePdfSpreadPref("hash-a", true);
    expect(loadPdfSpreadPref("hash-a")).toBe(true);
    expect(loadPdfSpreadPref("hash-b")).toBe(false);
    savePdfSpreadPref("hash-a", false);
    expect(loadPdfSpreadPref("hash-a")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("pdf film current", () => {
  it("notifies subscribers when the page under the camera changes", () => {
    resetPdfFilmCurrent();
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent((page) => seen.push(page));
    expect(seen).toEqual([1]);
    publishPdfFilmCurrent(1);
    publishPdfFilmCurrent(12);
    publishPdfFilmCurrent(12);
    publishPdfFilmCurrent(13);
    expect(seen).toEqual([1, 12, 13]);
    unsub();
    resetPdfFilmCurrent();
  });

  it("notifies subscribers when a new document resets to page 1", () => {
    publishPdfFilmCurrent(12);
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent((page) => seen.push(page));
    resetPdfFilmCurrent();
    expect(seen).toEqual([12, 1]);
    unsub();
  });

  it("follows camera Y through every page instead of skipping", () => {
    resetPdfFilmCurrent();
    const frames = [
      { pageId: 1, minY: 0, maxY: 100 },
      { pageId: 2, minY: 118, maxY: 218 },
      { pageId: 3, minY: 236, maxY: 336 },
      { pageId: 4, minY: 354, maxY: 454 },
      { pageId: 5, minY: 472, maxY: 572 },
    ];
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent((page) => seen.push(page));
    publishPdfFilmFromCamera(frames, 0, 1, 80);
    publishPdfFilmFromCamera(frames, -118, 1, 80);
    publishPdfFilmFromCamera(frames, -236, 1, 80);
    publishPdfFilmFromCamera(frames, -354, 1, 80);
    publishPdfFilmFromCamera(frames, -472, 1, 80);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    unsub();
    resetPdfFilmCurrent();
  });
});

describe("pdf reading frames", () => {
  it("stores layout frames for the camera without measuring the DOM", () => {
    resetPdfReadingFrames();
    expect(peekPdfReadingFrames()).toEqual([]);
    setPdfReadingFrames([{ pageId: 2, minY: 10, maxY: 20 }]);
    expect(peekPdfReadingFrames()).toEqual([{ pageId: 2, minY: 10, maxY: 20 }]);
    resetPdfReadingFrames();
    expect(peekPdfReadingFrames()).toEqual([]);
  });
});
