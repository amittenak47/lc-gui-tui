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
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  paintOrder,
  PDF_HOT_RADIUS,
  pdfJsDataUrls,
  pdfNavShouldPublish,
  pdfPagePaintScale,
  pdfStackHeight,
  windowedPages,
} from "./PdfDocument";

const FIXTURE = resolve(process.cwd(), "src/modes/fixtures/two-pages.pdf");

/** US Letter at 72dpi — what the fixture declares in its MediaBox. */
const LETTER = { width: 612, height: 792 };

describe("pdfJsDataUrls", () => {
  it("fetches wasm next to cmaps, with a trailing slash pdf.js requires", () => {
    const urls = pdfJsDataUrls("https://tauri.localhost/");
    expect(urls.wasmUrl).toBe("https://tauri.localhost/wasm/");
    expect(urls.cMapUrl).toBe("https://tauri.localhost/cmaps/");
    expect(urls.standardFontDataUrl).toBe("https://tauri.localhost/standard_fonts/");
  });
});

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
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
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
 * The paint window is what decides a textbook's GPU cost.
 *
 * Live canvases: current page ± {@link PDF_HOT_RADIUS}. The rest of this visit
 * is the session pagefile, not more GPU textures.
 */
describe("windowedPages", () => {
  it("keeps three neighbours either side of the page on screen", () => {
    expect(windowedPages([50], 200, PDF_HOT_RADIUS)).toHaveLength(7);
    expect(windowedPages([50], 200, PDF_HOT_RADIUS)[0]).toBe(47);
    expect(windowedPages([50], 200, PDF_HOT_RADIUS).at(-1)).toBe(53);
  });

  it("does not run off the front of the book", () => {
    expect(windowedPages([1], 60, PDF_HOT_RADIUS)).toEqual(
      Array.from({ length: 1 + PDF_HOT_RADIUS }, (_, i) => i + 1),
    );
  });

  it("does not run off the back", () => {
    expect(windowedPages([60], 60, PDF_HOT_RADIUS)).toEqual(
      Array.from({ length: 1 + PDF_HOT_RADIUS }, (_, i) => i + (60 - PDF_HOT_RADIUS)),
    );
  });

  it("merges the neighbours of two pages on screen at once", () => {
    expect(windowedPages([10, 11], 60, 3)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("opens on the first pages before the observer has reported", () => {
    expect(windowedPages([], 200)).toEqual(
      Array.from({ length: 1 + PDF_HOT_RADIUS }, (_, i) => i + 1),
    );
  });

  it("opens on the only page of a one-page document", () => {
    expect(windowedPages([], 1)).toEqual([1]);
  });

  it("stays a bounded ring however long the book is", () => {
    expect(windowedPages([900], 1500)).toHaveLength(1 + 2 * PDF_HOT_RADIUS);
  });
});

describe("pdfPagePaintScale", () => {
  it("uses the same 2× for the page on screen and its neighbours", () => {
    expect(pdfPagePaintScale(12, [12])).toBe(2);
    expect(pdfPagePaintScale(40, [12])).toBe(2);
  });
});

describe("pdfNavShouldPublish", () => {
  it("publishes the first reading", () => {
    expect(pdfNavShouldPublish(null, { count: 60, current: 1 })).toBe(true);
  });

  it("stays quiet when the page under the camera has not changed", () => {
    expect(pdfNavShouldPublish({ count: 60, current: 12 }, { count: 60, current: 12 })).toBe(
      false,
    );
  });

  it("publishes when the current page changes", () => {
    expect(pdfNavShouldPublish({ count: 60, current: 12 }, { count: 60, current: 13 })).toBe(
      true,
    );
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
