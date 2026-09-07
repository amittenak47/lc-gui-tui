import { describe, expect, it } from "vitest";

import { HOLD_MS, HOLD_TAP_FILL_DELAY_MS } from "../util/gesture";
import { wedgeHoldReleaseAction } from "./InkToolWheel";

describe("wedgeHoldReleaseAction", () => {
  it("edits after a lift once the fill has completed", () => {
    expect(wedgeHoldReleaseAction(HOLD_MS, HOLD_MS, false)).toBe("edit");
    expect(wedgeHoldReleaseAction(HOLD_MS + 16, HOLD_MS, false)).toBe("edit");
    expect(wedgeHoldReleaseAction(HOLD_MS - 1, HOLD_MS, false)).toBe("edit");
    expect(wedgeHoldReleaseAction(200, HOLD_MS, true)).toBe("edit");
  });

  it("keeps the wheel open so an unfinished hold can be retried", () => {
    expect(wedgeHoldReleaseAction(HOLD_TAP_FILL_DELAY_MS, HOLD_MS, false)).toBe(
      "retry",
    );
    expect(wedgeHoldReleaseAction(HOLD_MS - 50, HOLD_MS, false)).toBe("retry");
  });

  it("treats a short press as a tap", () => {
    expect(wedgeHoldReleaseAction(0, HOLD_MS, false)).toBe("tap");
    expect(wedgeHoldReleaseAction(HOLD_TAP_FILL_DELAY_MS - 1, HOLD_MS, false)).toBe(
      "tap",
    );
  });
});
