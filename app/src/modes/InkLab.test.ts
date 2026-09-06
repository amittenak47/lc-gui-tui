import { describe, expect, it } from "vitest";

import { formatInkLabHud, INK_LAB_HUD_ZERO } from "./InkLab";

describe("Ink lab HUD", () => {
  it("prints the zero readout the pad starts with", () => {
    const text = formatInkLabHud(INK_LAB_HUD_ZERO);
    expect(text).toContain("backend none");
    expect(text).toContain("paints 0");
    expect(text).toContain("hold no");
    expect(text).toContain("bake 0.0ms catmull");
  });
});
