/**
 * The measure, against a real file.
 *
 * What breaks a document pad is not the picture — it is the number the page
 * frame grows to. Get that wrong and the reader can scroll to the bottom of a
 * page that ends long before the pages do, and any ink down there is clipped
 * off. So this drives pdf.js over an actual two-page PDF and checks the
 * geometry the frame is sized from: the fit to the column, and the stack
 * height including the gaps between pages.
 *
 * `.mjs` on purpose, following the convention noted in `vite.config.ts`: a test
 * that reads a fixture off disk needs `node:fs`, and pulling @types/node into
 * the typechecked set would bring Node's globals with it for every file in
 * `src`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { paintOrder, pdfStackHeight, windowedPages } from "./PdfDocument";

const FIXTURE = resolve(process.cwd(), "src/modes/fixtures/two-pages.pdf");

/** US Letter at 72dpi — what the fixture declares in its MediaBox. */
const LETTER = { width: 612, height: 792 };

describe("pdfStackHeight", () => {
  it("is zero for a document with no pages", () => {
    expect(pdfStackHeight([])).toBe(0);
  });

  it("is the page height for a single page, with no gap", () => {
    expect(pdfStackHeight([{ height: 792 }], 18)).toBe(792);
  });

  it("counts the gaps between pages, not after the last one", () => {
    expect(pdfStackHeight([{ height: 100 }, { height: 100 }, { height: 100 }], 10)).toBe(
      320,
    );
  });

  it("handles a book of pages that are not all the same size", () => {
    // A scanned plate among typeset pages — the height is a sum, never a
    // multiple of the first page.
    expect(pdfStackHeight([{ height: 792 }, { height: 1000 }], 18)).toBe(1810);
  });
});

describe("the fixture, through pdf.js", () => {
  let pdfjs;

  beforeAll(async () => {
    /*
     * The legacy build, and only here.
     *
     * The app imports the modern one, which is right for a WebView; under Node
     * it reaches for DOMMatrix and friends at module scope and never gets as
     * far as parsing anything. Nothing in this file touches a canvas — it asks
     * for page boxes and text — so the legacy build's shims are exactly the
     * gap that needs filling.
     */
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Point at the real worker file rather than disabling it: pdf.js's
    // no-worker path still insists on a workerSrc before it will fall back.
    pdfjs.GlobalWorkerOptions.workerSrc = resolve(
      process.cwd(),
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    );
  });

  async function open() {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    return pdfjs.getDocument({ data: bytes }).promise;
  }

  it("reads both pages", async () => {
    const doc = await open();
    expect(doc.numPages).toBe(2);
  });

  it("reports the page box the file declares", async () => {
    const doc = await open();
    const viewport = (await doc.getPage(1)).getViewport({ scale: 1 });
    expect(Math.round(viewport.width)).toBe(LETTER.width);
    expect(Math.round(viewport.height)).toBe(LETTER.height);
  });

  it("fits a page to the frame width without distorting it", async () => {
    const frameWidth = 700;
    const doc = await open();
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const fit = frameWidth / natural.width;
    const laid = page.getViewport({ scale: fit });
    expect(Math.round(laid.width)).toBe(frameWidth);
    // Aspect ratio is what "without distorting it" means, and it is what keeps
    // ink drawn on a figure sitting on that figure.
    expect(laid.height / laid.width).toBeCloseTo(natural.height / natural.width, 6);
  });

  it("has text to select — the layer a quote is picked out of", async () => {
    const doc = await open();
    const content = await (await doc.getPage(1)).getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("")
      .trim();
    expect(text).toBe("Hash maps collide");
  });

  it("measures the fitted stack the frame has to grow to", async () => {
    const frameWidth = 700;
    const doc = await open();
    const laid = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      laid.push(page.getViewport({ scale: frameWidth / natural.width }));
    }
    const gap = 18;
    const expected = Math.round(laid[0].height) * 2 + gap;
    expect(
      Math.round(pdfStackHeight(laid.map((v) => ({ height: Math.round(v.height) })), gap)),
    ).toBe(expected);
  });
});


/**
 * The paint window is what decides a textbook's memory cost.
 *
 * A page bitmap at a reading column and 2× supersampling is roughly 12 MB, so
 * this rule is the difference between about 40 MB resident and, for a
 * 1500-page book, something no device has.
 */
describe("windowedPages", () => {
  it("keeps the previous, current and next page", () => {
    expect(windowedPages([26], 60)).toEqual([25, 26, 27]);
  });

  it("does not run off the front of the book", () => {
    expect(windowedPages([1], 60)).toEqual([1, 2]);
  });

  it("does not run off the back", () => {
    expect(windowedPages([60], 60)).toEqual([59, 60]);
  });

  it("merges the neighbours of two pages on screen at once", () => {
    expect(windowedPages([10, 11], 60)).toEqual([9, 10, 11, 12]);
  });

  it("opens on the first pages before the observer has reported", () => {
    expect(windowedPages([], 60)).toEqual([1, 2]);
  });

  it("opens on the only page of a one-page document", () => {
    expect(windowedPages([], 1)).toEqual([1]);
  });

  it("stays a handful of pages however long the book is", () => {
    expect(windowedPages([900], 1500)).toHaveLength(3);
  });
});

describe("paintOrder", () => {
  it("paints the page on screen before its off-screen neighbours", () => {
    // Scrolling up into page 5: window wants 4–6, only 5 is visible. Ascending
    // order used to burn a full render on 4 first.
    expect(paintOrder([4, 5, 6], [5])).toEqual([5, 4, 6]);
  });

  it("still prefers the focus when scrolling down", () => {
    expect(paintOrder([9, 10, 11], [10])).toEqual([10, 9, 11]);
  });

  it("falls back to ascending when nothing is marked visible yet", () => {
    expect(paintOrder([1, 2], [])).toEqual([1, 2]);
  });
});
