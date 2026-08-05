import { describe, expect, it } from "vitest";

import { statementSceneFont } from "../modes/codeFontSize";
import { readingColumnWidth } from "../templates/readingColumn";
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
        width: 420,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      body(96),
    ];

    const healed = healBoardLayout(elements, { readingSize: "M", viewportWidth: 420 });
    const frame = healed.find((el) => el.id.endsWith("-frame"))!;
    const text = healed.find((el) => el.id.endsWith("-body-0"))!;
    // The saved column is re-measured for this screen first, and only then is
    // the type set — 96 is a compounded font from an older build and the
    // reading size replaces it with one derived from the column it now sits in.
    const column = readingColumnWidth(420);
    expect(frame.width).toBe(column);
    expect(text.fontSize).toBe(statementSceneFont("M", column, 420));
    expect(text.width).toBeLessThan(column);
  });
});
