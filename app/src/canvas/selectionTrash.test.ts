import { describe, expect, it } from "vitest";

import { isDeletableElement, type TrashEl } from "./selectionTrash";

function el(patch: Partial<TrashEl> = {}): TrashEl {
  return { id: "el-1", x: 0, y: 0, ...patch };
}

/**
 * The trash used to appear only for library stamps, so a rectangle you drew
 * could be selected, moved and resized but not removed — and there is no
 * keyboard on the tablet this is written on.
 */
describe("isDeletableElement", () => {
  it("takes a plain shape the reader drew", () => {
    expect(isDeletableElement(el())).toBe(true);
  });

  it("takes a library stamp, which is all it used to take", () => {
    expect(isDeletableElement(el({ customData: { lcStamp: true } }))).toBe(true);
  });

  it("leaves the page's own frames alone", () => {
    expect(isDeletableElement(el({ customData: { lcRegionFrame: true } }))).toBe(false);
    expect(isDeletableElement(el({ customData: { lcRegion: "approach" } }))).toBe(false);
    expect(isDeletableElement(el({ customData: { lcMdInkFrame: true } }))).toBe(false);
  });

  it("leaves template scaffolding recognised only by its id", () => {
    expect(isDeletableElement(el({ id: "lcregion-approach-label" }))).toBe(false);
  });

  it("leaves a locked element alone", () => {
    expect(isDeletableElement(el({ locked: true }))).toBe(false);
  });

  it("takes a coach-drawn diagram — the board is the reader's", () => {
    expect(isDeletableElement(el({ id: "viz-3" }))).toBe(true);
  });
});
