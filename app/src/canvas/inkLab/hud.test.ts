import { describe, expect, it } from "vitest";

import { formatInkLabHud, INK_LAB_HUD_ZERO } from "./hud";

describe("Ink lab HUD", () => {
  it("prints the zero readout the overlay starts with", () => {
    const text = formatInkLabHud(INK_LAB_HUD_ZERO);
    expect(text).toContain("backend none");
    expect(text).toContain("paints 0");
    expect(text).toContain("hold no");
    expect(text).toContain("suffix hit");
    expect(text).toContain("bake 0.0ms catmull");
  });
});
