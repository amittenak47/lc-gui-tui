import { describe, expect, it, vi } from "vitest";

import {
  filmStripWheelDelta,
  loadPdfSpreadPref,
  peekPdfReadingFrames,
  pdfFilmRailScrollLeft,
  pdfFilmRailWindow,
  PDF_FILM_RAIL_CELL,
  PDF_FILM_THUMB_CSS,
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
  subscribePdfThumbs,
  openedPdfThumbHashes,
  PDF_FILM_CACHE,
  peekPdfLayoutBusy,
  publishPdfLayoutBusy,
  pdfSpreadSlotCountChanged,
  subscribePdfLayoutBusy,
  clearPdfFilmScope,
  resetPdfFilmScopes,
  peekPdfFilmCurrent,
  peekPdfIntersectingPages,
  publishPdfViewPages,
} from "./pdfFilm";

/** One mounted workspace. Nav state is keyed by tab, so tests need a tab. */
const SCOPE = "annotate-1";

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

describe("pdfFilmRailScrollLeft / pdfFilmRailWindow", () => {
  it("scrolls the strip so the current page is not at the start", () => {
    const left = pdfFilmRailScrollLeft(40, 400);
    expect(left).toBeGreaterThan(0);
    expect(left).toBe((40 - 1) * PDF_FILM_RAIL_CELL - (400 - PDF_FILM_THUMB_CSS) / 2);
  });

  it("keeps page 1 at scrollLeft 0", () => {
    expect(pdfFilmRailScrollLeft(1, 400)).toBe(0);
  });

  it("does not mount from page 1 just to include a late current page", () => {
    const left = pdfFilmRailScrollLeft(40, 400);
    const win = pdfFilmRailWindow(40, 80, left, 400);
    expect(win.start).toBeGreaterThan(1);
    expect(win.start).toBeLessThanOrEqual(40);
    expect(win.end).toBeGreaterThanOrEqual(40);
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

  it("drops session thumbs farthest from the page being remembered once the cap is full", () => {
    resetPdfThumbs();
    for (let page = 1; page <= PDF_FILM_CACHE + 4; page += 1) {
      rememberPdfThumb("doc-a", page, `url-${page}`);
    }
    const have = peekPdfThumbs("doc-a");
    expect(have.size).toBe(PDF_FILM_CACHE);
    expect(have.has(PDF_FILM_CACHE + 4)).toBe(true);
    expect(have.has(1)).toBe(false);
    resetPdfThumbs();
  });

  it("notifies only the hash a rail subscribed to", () => {
    resetPdfThumbs();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribePdfThumbs(() => a.push(peekPdfThumbs("doc-a").size), "doc-a");
    const unsubB = subscribePdfThumbs(() => b.push(peekPdfThumbs("doc-b").size), "doc-b");
    rememberPdfThumb("doc-b", 1, "b1");
    rememberPdfThumb("doc-a", 2, "a2");
    expect(a).toEqual([0, 1]);
    expect(b).toEqual([0, 1]);
    unsubA();
    unsubB();
    resetPdfThumbs();
  });

  it("remembers which hashes were opened this session so IDB prune can keep them", () => {
    resetPdfThumbs();
    rememberPdfThumb("open-a", 1, "x");
    hydratePdfThumbs("open-b", new Map());
    expect([...openedPdfThumbHashes()].sort()).toEqual(["open-a", "open-b"]);
    resetPdfThumbs();
    expect(openedPdfThumbHashes().size).toBe(0);
  });

  it("hydrates only a window around the page in view", () => {
    resetPdfThumbs();
    const stored = new Map<number, string>();
    for (let page = 1; page <= 40; page += 1) stored.set(page, `u${page}`);
    hydratePdfThumbs("doc-a", stored, 40);
    const have = peekPdfThumbs("doc-a");
    expect(have.size).toBe(PDF_FILM_CACHE);
    expect(have.has(40)).toBe(true);
    expect(have.has(1)).toBe(false);
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

  it("stops at prefer when the sweep is off, rather than walking the book", () => {
    // What the reader's idle decoder asks for. Unbounded, it decoded every
    // page of a textbook in the background of every reading pause.
    resetPdfThumbs();
    rememberPdfThumb("doc-a", 40, "x");
    expect(nextMissingPdfThumb("doc-a", 900, [40, 41], [], false)).toBe(41);
    rememberPdfThumb("doc-a", 41, "x");
    expect(nextMissingPdfThumb("doc-a", 900, [40, 41], [], false)).toBe(null);
    // The same state, swept, would still have 898 pages to grind through.
    expect(nextMissingPdfThumb("doc-a", 900, [40, 41], [], true)).toBe(1);
  });

  it("still honours skip when the sweep is off", () => {
    resetPdfThumbs();
    expect(nextMissingPdfThumb("doc-a", 900, [7, 8], [7], false)).toBe(8);
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
    publishPdfLayoutBusy(SCOPE, false);
    const seen: boolean[] = [];
    const unsub = subscribePdfLayoutBusy(SCOPE, (busy) => seen.push(busy));
    expect(seen).toEqual([false]);
    publishPdfLayoutBusy(SCOPE, true);
    publishPdfLayoutBusy(SCOPE, true);
    publishPdfLayoutBusy(SCOPE, false);
    expect(seen).toEqual([false, true]);
    expect(peekPdfLayoutBusy(SCOPE)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([false, true, false]);
    expect(peekPdfLayoutBusy(SCOPE)).toBe(false);
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
    resetPdfFilmCurrent(SCOPE);
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent(SCOPE, (page) => seen.push(page));
    expect(seen).toEqual([1]);
    publishPdfFilmCurrent(SCOPE, 1);
    publishPdfFilmCurrent(SCOPE, 12);
    publishPdfFilmCurrent(SCOPE, 12);
    publishPdfFilmCurrent(SCOPE, 13);
    expect(seen).toEqual([1, 12, 13]);
    unsub();
    resetPdfFilmCurrent(SCOPE);
  });

  it("notifies subscribers when a new document resets to page 1", () => {
    publishPdfFilmCurrent(SCOPE, 12);
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent(SCOPE, (page) => seen.push(page));
    resetPdfFilmCurrent(SCOPE);
    expect(seen).toEqual([12, 1]);
    unsub();
  });

  it("follows camera Y through every page instead of skipping", () => {
    resetPdfFilmCurrent(SCOPE);
    const frames = [
      { pageId: 1, minY: 0, maxY: 100 },
      { pageId: 2, minY: 118, maxY: 218 },
      { pageId: 3, minY: 236, maxY: 336 },
      { pageId: 4, minY: 354, maxY: 454 },
      { pageId: 5, minY: 472, maxY: 572 },
    ];
    const seen: number[] = [];
    const unsub = subscribePdfFilmCurrent(SCOPE, (page) => seen.push(page));
    publishPdfFilmFromCamera(SCOPE, frames, 0, 1, 80);
    publishPdfFilmFromCamera(SCOPE, frames, -118, 1, 80);
    publishPdfFilmFromCamera(SCOPE, frames, -236, 1, 80);
    publishPdfFilmFromCamera(SCOPE, frames, -354, 1, 80);
    publishPdfFilmFromCamera(SCOPE, frames, -472, 1, 80);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    unsub();
    resetPdfFilmCurrent(SCOPE);
  });

  it("keeps the flick-end guess on a separate channel from live current", () => {
    resetPdfFilmCurrent(SCOPE);
    resetPdfFilmPredicted(SCOPE);
    const live: number[] = [];
    const pred: number[] = [];
    const unsubLive = subscribePdfFilmCurrent(SCOPE, (page) => live.push(page));
    const unsubPred = subscribePdfFilmPredicted(SCOPE, (page) => pred.push(page));
    publishPdfFilmCurrent(SCOPE, 4);
    publishPdfFilmPredicted(SCOPE, 9);
    expect(live.at(-1)).toBe(4);
    expect(pred.at(-1)).toBe(9);
    unsubLive();
    unsubPred();
    resetPdfFilmPredicted(SCOPE);
    resetPdfFilmCurrent(SCOPE);
  });
});

describe("pdf preload pages", () => {
  it("is a separate list from live C", () => {
    resetPdfPreloadPages(SCOPE);
    publishPdfFilmCurrent(SCOPE, 10);
    publishPdfPreloadPages(SCOPE, [11, 12]);
    expect(peekPdfPreloadPages(SCOPE)).toEqual([11, 12]);
    resetPdfPreloadPages(SCOPE);
    expect(peekPdfPreloadPages(SCOPE)).toEqual([]);
    resetPdfFilmCurrent(SCOPE);
  });
});

describe("pdf reading frames", () => {
  it("stores layout frames for the camera without measuring the DOM", () => {
    resetPdfReadingFrames(SCOPE);
    expect(peekPdfReadingFrames(SCOPE)).toEqual([]);
    setPdfReadingFrames(SCOPE, [{ pageId: 2, minY: 10, maxY: 20 }]);
    expect(peekPdfReadingFrames(SCOPE)).toEqual([{ pageId: 2, minY: 10, maxY: 20 }]);
    resetPdfReadingFrames(SCOPE);
    expect(peekPdfReadingFrames(SCOPE)).toEqual([]);
  });
});

describe("nav state is per mounted document", () => {
  it("does not let one document move another one's page", () => {
    resetPdfFilmScopes();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribePdfFilmCurrent("annotate-1", (page: number) => a.push(page));
    const unsubB = subscribePdfFilmCurrent("annotate-2", (page: number) => b.push(page));

    publishPdfFilmCurrent("annotate-1", 12);
    expect(peekPdfFilmCurrent("annotate-1")).toBe(12);
    expect(peekPdfFilmCurrent("annotate-2")).toBe(1);

    // The other pane scrolls, and mounting used to reset both.
    publishPdfFilmCurrent("annotate-2", 3);
    resetPdfFilmCurrent("annotate-2");
    expect(peekPdfFilmCurrent("annotate-1")).toBe(12);

    expect(a).toEqual([1, 12]);
    expect(b).toEqual([1, 3, 1]);
    unsubA();
    unsubB();
    resetPdfFilmScopes();
  });

  it("keeps reading frames and visible pages apart", () => {
    resetPdfFilmScopes();
    setPdfReadingFrames("annotate-1", [{ pageId: 2, minY: 10, maxY: 20 }]);
    publishPdfViewPages("annotate-1", [2], [1, 3]);
    setPdfReadingFrames("annotate-2", [{ pageId: 9, minY: 0, maxY: 5 }]);

    expect(peekPdfReadingFrames("annotate-1")).toEqual([
      { pageId: 2, minY: 10, maxY: 20 },
    ]);
    expect(peekPdfReadingFrames("annotate-2")).toEqual([{ pageId: 9, minY: 0, maxY: 5 }]);
    expect(peekPdfIntersectingPages("annotate-1")).toEqual([2]);
    expect(peekPdfIntersectingPages("annotate-2")).toEqual([]);
    resetPdfFilmScopes();
  });

  it("forgets a closed tab without touching the one still open", () => {
    resetPdfFilmScopes();
    publishPdfFilmCurrent("annotate-1", 7);
    publishPdfFilmCurrent("annotate-2", 4);

    clearPdfFilmScope("annotate-1");

    // Gone means back to the start, not inherited from the other document.
    expect(peekPdfFilmCurrent("annotate-1")).toBe(1);
    expect(peekPdfFilmCurrent("annotate-2")).toBe(4);
    resetPdfFilmScopes();
  });
});
