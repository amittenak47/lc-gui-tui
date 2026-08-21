import { describe, expect, it } from "vitest";

import { linedSlotCanSkip, sameLinedSlot, type LinedSlot } from "./linedSlot";

const SLOT: LinedSlot = {
  left: 12,
  top: 40,
  width: 800,
  height: 1200,
  gap: 36,
  phase: 4.25,
};

describe("sameLinedSlot", () => {
  it("is true for identical geometry", () => {
    expect(sameLinedSlot(SLOT, { ...SLOT })).toBe(true);
  });

  it("notices a phase shift of a hundredth", () => {
    // Phase is rounded to 2dp on purpose — the rules walk if it is coarser.
    expect(sameLinedSlot(SLOT, { ...SLOT, phase: 4.26 })).toBe(false);
  });

  it("notices a moved or resized page", () => {
    expect(sameLinedSlot(SLOT, { ...SLOT, top: 41 })).toBe(false);
    expect(sameLinedSlot(SLOT, { ...SLOT, width: 801 })).toBe(false);
  });
});

describe("linedSlotCanSkip", () => {
  it("skips a repeat once the node is wearing the numbers", () => {
    expect(linedSlotCanSkip(SLOT, { ...SLOT }, true)).toBe(true);
  });

  it("never skips while there is no node", () => {
    // The regression: React mounts the overlay a render after the first pass
    // computes its geometry, so the first pass has numbers and no node. If the
    // second pass skips on "same numbers", nothing is ever written and the
    // rules stay invisible on any board whose camera then holds still.
    expect(linedSlotCanSkip(SLOT, { ...SLOT }, false)).toBe(false);
  });

  it("never skips the first pass", () => {
    expect(linedSlotCanSkip(null, SLOT, true)).toBe(false);
  });

  it("does not skip when the geometry moved", () => {
    expect(linedSlotCanSkip(SLOT, { ...SLOT, left: 13 }, true)).toBe(false);
  });
});
