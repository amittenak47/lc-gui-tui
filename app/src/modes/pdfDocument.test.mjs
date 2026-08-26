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

import { pageIdFromCamera } from "../canvas/inkPageIndex";
import { beforeAll, describe, expect, it } from "vitest";

import {
  layoutPdfPages,
  paintOrder,
  PAGE_GAP,
  PDF_DOC_PAD_TOP,
  PDF_HOT_RADIUS,
  PDF_PREVIEW_SCALE,
  PDF_RENDER_SCALE,
  PDF_REST_SCALE,
  pdfJsDataUrls,
  pdfNavShouldPublish,
  pdfPageFit,
  pdfPagePaintScale,
  pdfStackFrames,
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

  it("counts two stacked slots per sheet when spread is on", () => {
    expect(
      pdfStackHeight([{ height: 100 }, { height: 100 }, { height: 100 }], 18, true),
    ).toBe(600 + 18 * 5);
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

  it("doubles the fit so one two-up half fills the column", async () => {
    const frameWidth = 700;
    const doc = await open();
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const fit = pdfPageFit(natural.width, frameWidth, true);
    const laid = page.getViewport({ scale: fit });
    expect(Math.round(laid.width)).toBe(frameWidth * 2);
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
  it("keeps the hot-radius neighbours either side of the page on screen", () => {
    expect(windowedPages([50], 200, PDF_HOT_RADIUS)).toHaveLength(1 + 2 * PDF_HOT_RADIUS);
    expect(windowedPages([50], 200, PDF_HOT_RADIUS)[0]).toBe(50 - PDF_HOT_RADIUS);
    expect(windowedPages([50], 200, PDF_HOT_RADIUS).at(-1)).toBe(50 + PDF_HOT_RADIUS);
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

describe("pdfPageFit", () => {
  it("width-fits the whole sheet when spread is off", () => {
    expect(pdfPageFit(612, 700, false)).toBeCloseTo(700 / 612, 8);
  });

  it("fits one half of a two-up sheet to the column when spread is on", () => {
    expect(pdfPageFit(612, 700, true)).toBeCloseTo((2 * 700) / 612, 8);
  });
});

describe("layoutPdfPages", () => {
  const naturals = [
    { pageNumber: 1, width: 612, height: 792 },
    { pageNumber: 2, width: 612, height: 792 },
  ];

  it("width-fits from cached MediaBoxes without another getPage", () => {
    const laid = layoutPdfPages(naturals, 700, false);
    expect(laid).toHaveLength(2);
    expect(laid[0].width).toBe(700);
    expect(laid[0].sheetWidth).toBe(700);
    expect(laid[0].height).toBe(Math.round(792 * (700 / 612)));
  });

  it("relayouts the same naturals for spread — toggle must not reopen", () => {
    const oneUp = layoutPdfPages(naturals, 700, false);
    const twoUp = layoutPdfPages(naturals, 700, true);
    expect(twoUp[0].width).toBe(700);
    expect(twoUp[0].sheetWidth).toBe(1400);
    expect(twoUp[0].fit).toBeCloseTo(2 * oneUp[0].fit, 8);
    expect(twoUp[0].height).toBe(Math.round(792 * twoUp[0].fit));
  });
});

describe("pdfStackFrames", () => {
  const pages = [
    { pageNumber: 1, height: 100 },
    { pageNumber: 2, height: 100 },
    { pageNumber: 3, height: 100 },
  ];

  it("is one frame per PDF page when spread is off", () => {
    const frames = pdfStackFrames(pages, false, PAGE_GAP, 0);
    expect(frames).toEqual([
      { pageId: 1, minY: 0, maxY: 100 },
      { pageId: 2, minY: 118, maxY: 218 },
      { pageId: 3, minY: 236, maxY: 336 },
    ]);
  });

  it("stacks two slots per sheet when spread is on, same pageId", () => {
    const frames = pdfStackFrames(pages, true, PAGE_GAP, 0);
    expect(frames.map((frame) => frame.pageId)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(frames[1]).toEqual({ pageId: 1, minY: 118, maxY: 218 });
    expect(frames[2]).toEqual({ pageId: 2, minY: 236, maxY: 336 });
  });

  it("starts after the document padding so camera Y matches the stack", () => {
    const frames = pdfStackFrames(pages, false, PAGE_GAP, PDF_DOC_PAD_TOP);
    expect(frames[0].minY).toBe(PDF_DOC_PAD_TOP);
  });

  it("names every PDF page from camera Y without skipping", () => {
    const frames = pdfStackFrames(pages, false, PAGE_GAP, 0);
    expect(pageIdFromCamera(frames, 0, 1, 80)).toBe(1);
    expect(pageIdFromCamera(frames, -118, 1, 80)).toBe(2);
    expect(pageIdFromCamera(frames, -236, 1, 80)).toBe(3);
  });
});

describe("pdfPagePaintScale", () => {
  it("uses rest scale on the visible page and preview on neighbours", () => {
    expect(pdfPagePaintScale(12, [12])).toBe(PDF_REST_SCALE);
    expect(pdfPagePaintScale(12, [12])).toBe(PDF_RENDER_SCALE);
    expect(pdfPagePaintScale(40, [12])).toBe(PDF_PREVIEW_SCALE);
  });

  it("uses rest when nothing is visible yet", () => {
    expect(pdfPagePaintScale(1, [])).toBe(PDF_REST_SCALE);
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
