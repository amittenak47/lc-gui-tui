import { describe, expect, it } from "vitest";

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
  it("strips retired Excalidraw statement scaffold and widens the reading frame", () => {
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
      {
        id: "lcregion-constraints-title",
        type: "text",
        x: 36,
        y: 40,
        width: 300,
        height: 40,
        fontSize: 28,
        text: "Two Sum",
        customData: { lcRegion: "constraints" },
      },
      {
        id: "lcregion-constraints-meta-box-0",
        type: "rectangle",
        x: 36,
        y: 90,
        width: 64,
        height: 28,
        customData: { lcRegion: "constraints" },
      },
      {
        id: "lcregion-constraints-meta-0",
        type: "text",
        x: 44,
        y: 95,
        width: 48,
        height: 18,
        fontSize: 14,
        text: "Hard",
        customData: { lcRegion: "constraints" },
      },
      {
        id: "lcregion-constraints-meta-rule",
        type: "line",
        x: 36,
        y: 130,
        width: 300,
        height: 0,
        customData: { lcRegion: "constraints" },
      },
      body(96),
      {
        id: "student-note",
        type: "text",
        x: 40,
        y: 900,
        width: 120,
        height: 24,
        fontSize: 20,
        text: "mine",
        customData: { lcRegion: "approach" },
      },
    ];

    const healed = healBoardLayout(elements, { readingSize: "M", viewportWidth: 420 });
    const frame = healed.find((el) => el.id.endsWith("-frame"))!;
    const column = readingColumnWidth(420);
    expect(frame.width).toBe(column);
    expect(healed.some((el) => el.id === "lcregion-constraints-title")).toBe(false);
    expect(healed.some((el) => el.id === "lcregion-constraints-meta-box-0")).toBe(false);
    expect(healed.some((el) => el.id === "lcregion-constraints-meta-0")).toBe(false);
    expect(healed.some((el) => el.id === "lcregion-constraints-meta-rule")).toBe(false);
    expect(healed.some((el) => el.id === "lcregion-constraints-body-0")).toBe(false);
    expect(healed.some((el) => el.id === "student-note")).toBe(true);
  });
});
