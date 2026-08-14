import { describe, expect, it } from "vitest";

import { NAV_GAP_CAP_PX, splitBottomInsets } from "./safeArea";

describe("splitBottomInsets", () => {
  it("keeps a small visual gap as nav, not keyboard", () => {
    expect(splitBottomInsets(0, 32)).toEqual({ safeBottom: 32, keyboardInset: 0 });
  });

  it("treats a gap at the cap as nav", () => {
    expect(splitBottomInsets(0, NAV_GAP_CAP_PX)).toEqual({
      safeBottom: NAV_GAP_CAP_PX,
      keyboardInset: 0,
    });
  });

  it("treats a large gap as keyboard and leaves env as nav", () => {
    expect(splitBottomInsets(24, 280)).toEqual({ safeBottom: 24, keyboardInset: 280 });
  });

  it("uses env when there is no gap", () => {
    expect(splitBottomInsets(24, 0)).toEqual({ safeBottom: 24, keyboardInset: 0 });
  });

  it("is zero when both are zero", () => {
    expect(splitBottomInsets(0, 0)).toEqual({ safeBottom: 0, keyboardInset: 0 });
  });
});
