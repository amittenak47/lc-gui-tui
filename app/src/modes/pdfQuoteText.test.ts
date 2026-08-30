import { describe, expect, it, vi } from "vitest";

import { fillPdfQuoteText, registerPdfQuoteTextFill } from "./pdfQuoteText";

describe("pdfQuoteText", () => {
  it("runs the registered filler for that film scope", async () => {
    const fill = vi.fn(async (page: number) => page === 3);
    const stop = registerPdfQuoteTextFill("film-a", fill);
    expect(await fillPdfQuoteText("film-a", 3)).toBe(true);
    expect(fill).toHaveBeenCalledWith(3);
    expect(await fillPdfQuoteText("other", 3)).toBe(false);
    expect(await fillPdfQuoteText("film-a", 0)).toBe(false);
    stop();
    expect(await fillPdfQuoteText("film-a", 3)).toBe(false);
  });
});
