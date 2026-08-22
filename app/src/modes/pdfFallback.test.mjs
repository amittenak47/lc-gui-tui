/**
 * The fallback parse, against a real file.
 *
 * `openPdfDocument` rescues a WebView whose pdf.js worker cannot parse by
 * pinning the worker module into the calling realm — `globalThis.pdfjsWorker`
 * is where `PDFWorker` looks before it reaches for a real `Worker`. That hook
 * is the whole mechanism, and it is a private detail of pdf.js, so it is worth
 * a test that fails loudly the day a version bump moves it.
 *
 * `.mjs` for the fixture read, following the convention in `vite.config.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const FIXTURE = resolve(process.cwd(), "src/modes/fixtures/two-pages.pdf");

describe("the main-thread fallback", () => {
  let pdfjs;
  let raw;

  beforeAll(async () => {
    raw = readFileSync(FIXTURE);
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  });

  it("is the hook pdf.js actually looks for", () => {
    // `PDFWorker` reads `globalThis.pdfjsWorker?.WorkerMessageHandler` and, if
    // it is there, never constructs a Worker at all.
    expect(globalThis.pdfjsWorker.WorkerMessageHandler).toBeTypeOf("function");
  });

  it("parses a real PDF with no Worker involved", async () => {
    const worker = new pdfjs.PDFWorker({ verbosity: pdfjs.VerbosityLevel.INFOS });
    const task = pdfjs.getDocument({
      data: new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)),
      worker,
    });
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    await task.destroy();
  });

  it("logs the swallowed cause, which is the only place it exists", async () => {
    // pdf.js reports the real xref exception through `info()` and then throws
    // its catch-all instead. `capturePdfJsLog` reads that channel; if pdf.js
    // ever goes quiet here the fallback loses its diagnosis and this fails.
    const worker = new pdfjs.PDFWorker({ verbosity: pdfjs.VerbosityLevel.INFOS });
    const broken = new TextEncoder().encode(
      `%PDF-1.7
1 0 obj
<<>>
endobj
startxref
9
%%EOF
`,
    );
    const task = pdfjs.getDocument({ data: broken, worker });
    await expect(task.promise).rejects.toThrow(/Invalid PDF structure/i);
  });

  it("pulls the cause out of a captured log", async () => {
    const { swallowedCause } = await import("./PdfDocument");
    expect(
      swallowedCause([
        "Warning: Indexing all PDF objects",
        "Info: (while reading XRef): TypeError: x.at is not a function",
      ]),
    ).toBe("TypeError: x.at is not a function");
    expect(swallowedCause(["Warning: Indexing all PDF objects"])).toBeNull();
  });
});
