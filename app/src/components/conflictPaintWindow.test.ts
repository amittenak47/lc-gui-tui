/**
 * @vitest-environment jsdom
 *
 * What a conflict pane's paint window covers.
 *
 * The split mounts two document stacks over a reader that is often still
 * mounted. These assert the thing that made that expensive: the ring each pane
 * asks the pump to keep decoded.
 */
import { describe, expect, it } from "vitest";

import { CONFLICT_PAINT_RADIUS } from "./ConflictPagePreview";
import {
  PDF_PREVIEW_RADIUS,
  PDF_PREVIEW_SCALE,
  pdfDecodeQueue,
  pdfOuterPages,
  pdfRestPages,
} from "../modes/pdfPaintWindow";

const LAST = 400;
const FOCUS = 40;

describe("conflict pane paint ring", () => {
  it("is narrower than the reader's, which is the whole point", () => {
    expect(CONFLICT_PAINT_RADIUS).toBeLessThan(PDF_PREVIEW_RADIUS);
    expect(CONFLICT_PAINT_RADIUS).toBeGreaterThanOrEqual(1);
  });

  it("keeps the focused page and one either side", () => {
    expect(pdfOuterPages(FOCUS, LAST, CONFLICT_PAINT_RADIUS)).toEqual([39, 40, 41]);
  });

  it("holds nothing far from the page the conflict is about", () => {
    const ring = new Set(pdfOuterPages(FOCUS, LAST, CONFLICT_PAINT_RADIUS));
    for (const page of [1, 20, 37, 43, 200, LAST]) {
      expect(ring.has(page)).toBe(false);
    }
  });

  it("clamps at the ends of the book rather than asking for page zero", () => {
    expect(pdfOuterPages(1, LAST, CONFLICT_PAINT_RADIUS)).toEqual([1, 2]);
    expect(pdfOuterPages(LAST, LAST, CONFLICT_PAINT_RADIUS)).toEqual([399, 400]);
  });

  it("does not queue a decode for a page outside the ring", () => {
    const rest = new Set(pdfRestPages(FOCUS, LAST, [FOCUS]));
    const outer = new Set(pdfOuterPages(FOCUS, LAST, CONFLICT_PAINT_RADIUS));
    const queue = pdfDecodeQueue(
      FOCUS,
      LAST,
      rest,
      outer,
      [FOCUS],
      // Nothing decoded yet, every page laid out.
      () => 0,
      () => 1,
    );
    const pages = [...new Set(queue.map((job) => job.page))].sort((a, b) => a - b);
    expect(pages).toEqual([39, 40, 41]);
    expect(queue.some((job) => job.page === 37)).toBe(false);
    expect(queue.some((job) => job.page === 200)).toBe(false);
  });

  it("queues two full rings' less than the reader would for the same page", () => {
    const build = (radius: number) => {
      const outer = new Set(pdfOuterPages(FOCUS, LAST, radius));
      return pdfDecodeQueue(
        FOCUS,
        LAST,
        new Set(pdfRestPages(FOCUS, LAST, [FOCUS])),
        outer,
        [FOCUS],
        () => 0,
        () => 1,
      );
    };
    const previews = (jobs: { target: number }[]) =>
      jobs.filter((job) => job.target === PDF_PREVIEW_SCALE).length;
    // Two panes on the narrow ring still cost less than one on the reader's.
    expect(2 * previews(build(CONFLICT_PAINT_RADIUS))).toBeLessThan(
      previews(build(PDF_PREVIEW_RADIUS)),
    );
  });
});
