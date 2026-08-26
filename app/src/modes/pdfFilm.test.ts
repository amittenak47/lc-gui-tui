import { describe, expect, it, vi } from "vitest";

import {
  filmStripWheelDelta,
  loadPdfSpreadPref,
  peekPdfReadingFrames,
  publishPdfFilmCurrent,
  publishPdfFilmFromCamera,
  peekPdfPreloadPages,
  publishPdfFilmPredicted,
  publishPdfPreloadPages,
  resetPdfFilmCurrent,
  resetPdfFilmPredicted,
  resetPdfPreloadPages,
  resetPdfReadingFrames,
  resetPdfThumbs,
  savePdfSpreadPref,
  setPdfReadingFrames,
  subscribePdfFilmCurrent,
  subscribePdfFilmPredicted,
  thumbWindow,
  trimThumbCache,
  rememberPdfThumb,
  peekPdfThumb,
  peekPdfThumbs,
  nextMissingPdfThumb,
  pdfThumbViewportScale,
  hydratePdfThumbs,
  peekPdfLayoutBusy,
  publishPdfLayoutBusy,
  pdfSpreadSlotCountChanged,
  subscribePdfLayoutBusy,
} from "./pdfFilm";

describe("filmStripWheelDelta", () => {
  it("turns a vertical wheel into horizontal strip travel", () => {
    expect(filmStripWheelDelta(0, 80)).toBe(80);
    expect(filmStripWheelDelta(-40, 10)).toBe(-40);
  });
});

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

describe("session thumbs by document hash", () => {
  it("keeps every viewed page, isolated per hash", () => {
    resetPdfThumbs();
    rememberPdfThumb("doc-a", 1, "url-1");
    rememberPdfThumb("doc-a", 40, "url-40");
    rememberPdfThumb("doc-b", 1, "other");
    expect(peekPdfThumb("doc-a", 1)).toBe("url-1");
    expect(peekPdfThumb("doc-a", 40)).toBe("url-40");
    expect(peekPdfThumb("doc-a", 2)).toBe(null);
    expect(peekPdfThumb("doc-b", 1)).toBe("other");
    expect([...peekPdfThumbs("doc-a").keys()]).toEqual([1, 40]);
    resetPdfThumbs();
    expect(peekPdfThumb("doc-a", 1)).toBe(null);
  });

  it("ignores empty hash and invalid pages", () => {
    resetPdfThumbs();
    rememberPdfThumb("", 1, "x");
    rememberPdfThumb("doc-a", 0, "x");
    rememberPdfThumb("doc-a", 1, "");
    expect(peekPdfThumbs("doc-a").size).toBe(0);
    expect(peekPdfThumb("", 1)).toBe(null);
  });

  it("hydrates stored thumbs without replacing ones already in memory", () => {
    resetPdfThumbs();
    rememberPdfThumb("doc-a", 1, "live");
    hydratePdfThumbs(
      "doc-a",
      new Map([
        [1, "disk-old"],
        [2, "disk-2"],
      ]),
    );
    expect(peekPdfThumb("doc-a", 1)).toBe("live");
    expect(peekPdfThumb("doc-a", 2)).toBe("disk-2");
    resetPdfThumbs();
  });
});

describe("pdfThumbViewportScale", () => {
  it("sizes the bitmap to the film CSS width, not rest-2", () => {
    expect(pdfThumbViewportScale(612, 48, 1)).toBeCloseTo(48 / 612, 5);
    expect(pdfThumbViewportScale(612, 48, 2)).toBeCloseTo(96 / 612, 5);
  });
});

describe("nextMissingPdfThumb", () => {
  it("walks prefer first, then the rest of the file", () => {
    resetPdfThumbs();
    rememberPdfThumb("doc-a", 2, "x");
    expect(nextMissingPdfThumb("doc-a", 4, [2, 3])).toBe(3);
    expect(nextMissingPdfThumb("doc-a", 4, [])).toBe(1);
    rememberPdfThumb("doc-a", 1, "x");
    rememberPdfThumb("doc-a", 3, "x");
    rememberPdfThumb("doc-a", 4, "x");
    expect(nextMissingPdfThumb("doc-a", 4, [])).toBe(null);
  });

  it("skips failed pages so a bad sheet cannot spin the idle pass", () => {
    resetPdfThumbs();
    expect(nextMissingPdfThumb("doc-a", 3, [], [1])).toBe(2);
  });
});

describe("pdfSpreadSlotCountChanged", () => {
  it("is true only once the slot list doubles or halves", () => {
    expect(pdfSpreadSlotCountChanged(50, 50)).toBe(false);
    expect(pdfSpreadSlotCountChanged(50, 100)).toBe(true);
    expect(pdfSpreadSlotCountChanged(100, 50)).toBe(true);
    expect(pdfSpreadSlotCountChanged(0, 50)).toBe(false);
  });
});

describe("pdf layout busy", () => {
  it("notifies subscribers when spread relayout starts and when C is ready", () => {
    vi.useFakeTimers();
    publishPdfLayoutBusy(false);
    const seen: boolean[] = [];
    const unsub = subscribePdfLayoutBusy((busy) => seen.push(busy));
    expect(seen).toEqual([false]);
    publishPdfLayoutBusy(true);
    publishPdfLayoutBusy(true);
    publishPdfLayoutBusy(false);
    expect(seen).toEqual([false, true]);
    expect(peekPdfLayoutBusy()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([false, true, false]);
    expect(peekPdfLayoutBusy()).toBe(false);
    unsub();
    vi.useRealTimers();
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

  it("keeps the flick-end guess on a separate channel from live current", () => {
    resetPdfFilmCurrent();
    resetPdfFilmPredicted();
    const live: number[] = [];
    const pred: number[] = [];
    const unsubLive = subscribePdfFilmCurrent((page) => live.push(page));
    const unsubPred = subscribePdfFilmPredicted((page) => pred.push(page));
    publishPdfFilmCurrent(4);
    publishPdfFilmPredicted(9);
    expect(live.at(-1)).toBe(4);
    expect(pred.at(-1)).toBe(9);
    unsubLive();
    unsubPred();
    resetPdfFilmPredicted();
    resetPdfFilmCurrent();
  });
});

describe("pdf preload pages", () => {
  it("is a separate list from live C", () => {
    resetPdfPreloadPages();
    publishPdfFilmCurrent(10);
    publishPdfPreloadPages([11, 12]);
    expect(peekPdfPreloadPages()).toEqual([11, 12]);
    resetPdfPreloadPages();
    expect(peekPdfPreloadPages()).toEqual([]);
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
