import { describe, expect, it } from "vitest";

import { healBoardLayout } from "./healBoardLayout";
import type { ReadingElement } from "../modes/applyBoardReadingSize";

function body(fontSize: number): ReadingElement {
  return {
    id: "lcregion-constraints-body-0",
    type: "text",
    x: 36,
    y: 200,
    width: 400,
    height: 80,
    fontSize,
    text: "We have two special characters.",
    customData: {
      lcRegion: "constraints",
      lcRegionOx: 36,
      lcRegionOy: 200,
      lcFontBase: 28,
      lcLineHeightBase: 40 / 28,
      lcRegionOyBase: 200,
    },
  };
}

describe("healBoardLayout", () => {
  it("repairs inflated body fonts from older saved boards", () => {
    const elements: ReadingElement[] = [
      {
        id: "lcregion-constraints-frame",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 1200,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      body(96),
    ];

    const healed = healBoardLayout(elements, { readingSize: "M" });
    const text = healed.find((el) => el.id.endsWith("-body-0"))!;
    expect(text.fontSize).toBe(24);
    expect(text.width).toBeGreaterThan(400);
  });
});
