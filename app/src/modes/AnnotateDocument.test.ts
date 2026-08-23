import { describe, expect, it } from "vitest";

import {
  columnIsMeasurable,
  MIN_MEASURABLE_WIDTH_PX,
  shouldReportDocumentHeight,
} from "./AnnotateDocument";

describe("columnIsMeasurable", () => {
  it("stays silent on a box that has not been laid out", () => {
    expect(columnIsMeasurable(0)).toBe(false);
  });

  it("stays silent on a collapsed column", () => {
    expect(columnIsMeasurable(MIN_MEASURABLE_WIDTH_PX - 1)).toBe(false);
  });

  it("lets a real paper column report, including an empty note's zero", () => {
    expect(columnIsMeasurable(MIN_MEASURABLE_WIDTH_PX)).toBe(true);
    expect(columnIsMeasurable(760)).toBe(true);
  });
});

describe("shouldReportDocumentHeight", () => {
  it("never reports a box that has not been laid out", () => {
    expect(shouldReportDocumentHeight(0, true)).toBe(false);
    expect(shouldReportDocumentHeight(0, false)).toBe(false);
  });

  it("reports a file with text even while the column is still narrowing", () => {
    // Waiting for 80px here left markdown on the 1100 floor and pinned scroll.
    expect(shouldReportDocumentHeight(40, true)).toBe(true);
  });

  it("still waits for a real column on an empty note", () => {
    expect(shouldReportDocumentHeight(40, false)).toBe(false);
    expect(shouldReportDocumentHeight(MIN_MEASURABLE_WIDTH_PX, false)).toBe(true);
  });
});
