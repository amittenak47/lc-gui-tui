import { describe, expect, it } from "vitest";

import { borrowPdfDocument, dropPdfDocument, lendPdfDocument } from "./pdfOpenDocs";

describe("pdfOpenDocs", () => {
  it("lends by hash and drops only that instance", () => {
    const first = { numPages: 1 } as never;
    const second = { numPages: 2 } as never;
    lendPdfDocument("binabc-k", first);
    expect(borrowPdfDocument("binabc-k")).toBe(first);
    dropPdfDocument("binabc-k", second);
    expect(borrowPdfDocument("binabc-k")).toBe(first);
    dropPdfDocument("binabc-k", first);
    expect(borrowPdfDocument("binabc-k")).toBeNull();
  });
});
