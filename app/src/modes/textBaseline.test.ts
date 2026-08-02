import { describe, expect, it } from "vitest";

import { FONT_UI } from "../templates/skeleton";
import { STATEMENT_LINE_HEIGHT_RATIO } from "./codeFontSize";
import {
  defaultLineHeight,
  linedRuleClearance,
  textBaselineOffset,
  topYForLinedRow,
} from "./textBaseline";

describe("textBaseline", () => {
  it("matches Excalidraw Helvetica metrics at the family default lineHeight", () => {
    const lh = defaultLineHeight(FONT_UI);
    expect(lh).toBe(1.15);
    const offset = textBaselineOffset(28, lh, FONT_UI);
    // ~0.8× fontSize — mid-box would be wrong; alphabetic sits near the bottom.
    expect(offset).toBeGreaterThan(20);
    expect(offset).toBeLessThan(28);
  });

  it("places baseline just above the ruled line", () => {
    const pitch = 36 * STATEMENT_LINE_HEIGHT_RATIO;
    const frameY = 100;
    const fontSize = 28;
    const lh = defaultLineHeight(FONT_UI);
    const topY = topYForLinedRow(frameY, 4, pitch, fontSize, FONT_UI, lh);
    const baseline = topY + textBaselineOffset(fontSize, lh, FONT_UI);
    const ruleY = frameY + 4 * pitch;
    expect(baseline).toBeCloseTo(ruleY - linedRuleClearance(fontSize), 1);
    expect(baseline).toBeLessThan(ruleY);
  });
});
