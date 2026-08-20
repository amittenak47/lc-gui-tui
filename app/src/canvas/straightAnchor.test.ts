import { describe, expect, it } from "vitest";

import { shiftAnchorAt, straightAnchorFor, straightenFromAnchor } from "./straightAnchor";

describe("straightAnchorFor", () => {
  it("is null for ordinary freehand", () => {
    expect(straightAnchorFor(false, null)).toBeNull();
  });

  it("pins the toggle at the start of the stroke", () => {
    // The toggle is "this whole stroke is a chord" — the same rule with the
    // anchor at zero, rather than a second code path beside the gesture.
    expect(straightAnchorFor(true, null)).toBe(0);
  });

  it("lets a live Shift win over the toggle", () => {
    // Pressing a key mid-stroke means the thing you are doing now, not the mode
    // you set earlier.
    expect(straightAnchorFor(true, 12)).toBe(12);
    expect(straightAnchorFor(false, 12)).toBe(12);
  });
});

describe("straightenFromAnchor", () => {
  const head = ["a", "b", "c", "d"];

  it("keeps the freehand before the anchor and collapses the tail", () => {
    expect(straightenFromAnchor(head, 1, "nib")).toEqual(["a", "b", "nib"]);
  });

  it("collapses the whole stroke when the anchor is the start", () => {
    expect(straightenFromAnchor(head, 0, "nib")).toEqual(["a", "nib"]);
  });

  it("stays one chord however far the pen travels", () => {
    // The tail is replaced, never appended to, so a long drag does not leave a
    // trail of points behind the chord.
    let pts: string[] = ["a", "b"];
    for (const nib of ["n1", "n2", "n3"]) pts = straightenFromAnchor(pts, 1, nib);
    expect(pts).toEqual(["a", "b", "n3"]);
  });

  it("clamps an anchor past the end rather than dropping the stroke", () => {
    expect(straightenFromAnchor(head, 99, "nib")).toEqual([...head, "nib"]);
  });

  it("handles a press before the first point", () => {
    expect(straightenFromAnchor([], 0, "nib")).toEqual(["nib"]);
  });
});

describe("shiftAnchorAt", () => {
  it("anchors under the nib mid-stroke", () => {
    expect(shiftAnchorAt(5)).toBe(4);
  });

  it("anchors at the start when no stroke is live", () => {
    // Shift-then-draw is a straight line from first contact.
    expect(shiftAnchorAt(null)).toBe(0);
    expect(shiftAnchorAt(0)).toBe(0);
  });
});
