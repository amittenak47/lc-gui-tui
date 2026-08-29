/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { blitSheetToSlots, forgetSlotBlit } from "./pdfSheetCache";

/**
 * jsdom has no 2D context, so each slot gets a stub that counts draws.
 *
 * Counting is the whole point of these tests: what the pump costs is not the
 * pixels it ends up with but how many times a turn it throws them away and
 * puts them back.
 */
function makeSlot(half?: "left" | "right"): {
  slot: HTMLElement;
  canvas: HTMLCanvasElement;
  draws: () => number;
  resizes: () => number;
} {
  const slot = document.createElement("div");
  const canvas = document.createElement("canvas");
  if (half) slot.dataset.pdfHalf = half;
  slot.append(canvas);

  let draws = 0;
  let resizes = 0;
  let width = 0;
  let height = 0;
  // Reassigning `width` is what discards the backing store, so count the
  // assignments rather than trusting the value to have changed.
  Object.defineProperty(canvas, "width", {
    get: () => width,
    set: (next: number) => {
      resizes += 1;
      width = next;
    },
  });
  Object.defineProperty(canvas, "height", {
    get: () => height,
    set: (next: number) => {
      height = next;
    },
  });
  canvas.getContext = vi.fn(() => ({
    drawImage: () => {
      draws += 1;
    },
  })) as unknown as HTMLCanvasElement["getContext"];

  return { slot, canvas, draws: () => draws, resizes: () => resizes };
}

/** A write-once sheet: a distinct object stands for distinct pixels. */
function sheet(): CanvasImageSource {
  return {} as CanvasImageSource;
}

describe("blitSheetToSlots", () => {
  let src: CanvasImageSource;

  beforeEach(() => {
    src = sheet();
  });

  it("paints a slot that has nothing on it", () => {
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    expect(one.draws()).toBe(1);
    expect(one.canvas.width).toBe(100);
    expect(one.canvas.height).toBe(200);
    expect(one.slot.getAttribute("data-painted")).toBe("");
  });

  it("leaves a slot alone when the same sheet is blitted again", () => {
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    // The pump re-blits the whole preview ring at the top of every turn.
    expect(one.draws()).toBe(1);
    expect(one.resizes()).toBe(1);
    expect(one.slot.getAttribute("data-painted")).toBe("");
  });

  it("repaints when the sheet changes under the same size", () => {
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    blitSheetToSlots(sheet(), 200, 400, [one.slot], 100, 200);
    expect(one.draws()).toBe(2);
  });

  it("repaints on a 2x→1x demote of the same sheet", () => {
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 200, 400);
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    expect(one.draws()).toBe(2);
    expect(one.canvas.width).toBe(100);
  });

  it("repaints after the slot has been zeroed out", () => {
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    one.canvas.width = 0;
    one.canvas.height = 0;
    forgetSlotBlit(one.canvas);
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    expect(one.draws()).toBe(2);
  });

  it("repaints a zeroed slot even without the forget call", () => {
    // Size is the invariant the stamp rides on — a 0x0 backing store can
    // never match, whatever the stamp still says.
    const one = makeSlot();
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    one.canvas.width = 0;
    one.canvas.height = 0;
    blitSheetToSlots(src, 200, 400, [one.slot], 100, 200);
    expect(one.draws()).toBe(2);
  });

  it("keeps the two halves of a spread apart", () => {
    const left = makeSlot("left");
    const right = makeSlot("right");
    const slots = [left.slot, right.slot];
    blitSheetToSlots(src, 200, 400, slots, 101, 200);
    expect(left.canvas.width).toBe(51);
    expect(right.canvas.width).toBe(50);

    blitSheetToSlots(src, 200, 400, slots, 101, 200);
    expect(left.draws()).toBe(1);
    expect(right.draws()).toBe(1);
  });

  it("does not mistake one half of a spread for the other", () => {
    // Same half width, different source rect: a stamp keyed on the canvas
    // size alone would skip the second blit and show the left page twice.
    const right = makeSlot("right");
    blitSheetToSlots(src, 200, 400, [right.slot, makeSlot("left").slot], 100, 200);
    const drewAsRight = right.draws();
    blitSheetToSlots(src, 200, 400, [right.slot], 50, 200);
    expect(right.draws()).toBe(drewAsRight + 1);
  });
});
