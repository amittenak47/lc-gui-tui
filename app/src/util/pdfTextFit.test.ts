import { describe, expect, it } from "vitest";

import { refitScaleX, spannedItems } from "./pdfTextFit";

describe("refitScaleX", () => {
  it("leaves a span that already covers its glyphs alone", () => {
    expect(refitScaleX({ want: 200, measured: 200, scaleX: 1.1 })).toBeNull();
    // Sub-pixel metrics never land exactly; half a percent is the same width.
    expect(refitScaleX({ want: 200, measured: 200.4, scaleX: 1 })).toBeNull();
  });

  it("stretches a span the WebView laid out short", () => {
    // Android's system font size reaches the WebView as a text zoom: the DOM
    // string comes out at 85% while the canvas pdf.js measured stays at 100%.
    const next = refitScaleX({ want: 726, measured: 617.1, scaleX: 1.1 });
    expect(next).toBeCloseTo(1.1 / 0.85, 3);
  });

  it("shrinks a span laid out long", () => {
    expect(refitScaleX({ want: 100, measured: 125, scaleX: 1 })).toBeCloseTo(0.8, 5);
  });

  it("keeps out of the way of a span with nothing to measure", () => {
    // A span that has not been laid out reports zero, and a page mid-paint is
    // late rather than wrong — dividing by it would stamp a garbage transform.
    expect(refitScaleX({ want: 200, measured: 0, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 0, measured: 200, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 200, measured: Number.NaN, scaleX: 1 })).toBeNull();
  });

  it("refuses a correction too large to have come from a measurement", () => {
    expect(refitScaleX({ want: 4000, measured: 0.01, scaleX: 1 })).toBeNull();
    expect(refitScaleX({ want: 0.01, measured: 4000, scaleX: 1 })).toBeNull();
  });
});

describe("spannedItems", () => {
  it("drops the marked-content markers so spans and items line up", () => {
    const items = [
      { type: "beginMarkedContent" },
      { str: "Two ideas changed the world.", width: 726 },
      { type: "endMarkedContent" },
      { str: "", width: 0 },
      { str: "In 1448", width: 120 },
    ];
    expect(spannedItems(items).map((item) => item.str)).toEqual([
      "Two ideas changed the world.",
      "",
      "In 1448",
    ]);
  });
});
