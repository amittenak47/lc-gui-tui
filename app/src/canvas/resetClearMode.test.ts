/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { cycleResetClearMode, resetClearModeLabel } from "./resetClearMode";

describe("cycleResetClearMode", () => {
  it("walks all → ink → annotations → all", () => {
    expect(cycleResetClearMode("all")).toBe("ink");
    expect(cycleResetClearMode("ink")).toBe("annotations");
    expect(cycleResetClearMode("annotations")).toBe("all");
  });

  it("names each mode for the reset button", () => {
    expect(resetClearModeLabel("all")).toBe("ink and annotations");
    expect(resetClearModeLabel("ink")).toBe("ink");
    expect(resetClearModeLabel("annotations")).toBe("annotations");
  });
});
