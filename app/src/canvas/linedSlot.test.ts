import { describe, expect, it } from "vitest";

import { applyLinedSlotStyle, linedOverlayViewport, linedSlotCanSkip, sameLinedSlot, type LinedSlot } from "./linedSlot";

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

describe("linedOverlayViewport", () => {
  it("covers the board hole, not the authored sheet", () => {
    expect(linedOverlayViewport(1600, 900, 36, 4.25)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
      gap: 36,
      phase: 4.25,
    });
  });
});

describe("applyLinedSlotStyle", () => {
  it("pins the overlay to the page box and rides pan on the rules", () => {
    const node = {
      style: {} as Record<string, string>,
    };
    applyLinedSlotStyle(node as unknown as HTMLElement, SLOT, 12);
    expect(node.style.left).toBe("12px");
    expect(node.style.top).toBe("40px");
    expect(node.style.right).toBe("auto");
    expect(node.style.bottom).toBe("auto");
    expect(node.style.width).toBe("800px");
    expect(node.style.height).toBe("1200px");
    expect(node.style.transform).toBe("");
    expect(node.style.backgroundSize).toBe("100% 36px");
    expect(node.style.backgroundPosition).toBe("0 16.25px");
  });
});
