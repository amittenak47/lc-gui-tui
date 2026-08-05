import { describe, expect, it } from "vitest";

import {
  contentBottomInFrame,
  DRAW_HEADER_BAND,
  growDrawHeight,
  initialDrawHeight,
} from "./drawPageGrowth";

describe("initialDrawHeight", () => {
  it("is one page plus half buffer", () => {
    expect(initialDrawHeight(1000)).toBe(1500);
    expect(initialDrawHeight(800)).toBe(1200);
  });
});

describe("growDrawHeight", () => {
  const base = 1000;

  it("keeps the initial floor on an empty page", () => {
    expect(
      growDrawHeight({
        basePageH: base,
        currentH: 1500,
        contentBottomRel: DRAW_HEADER_BAND,
      }),
    ).toBe(1500);
  });

  it("adds half-page buffers while content nears the bottom", () => {
    expect(
      growDrawHeight({
        basePageH: base,
        currentH: 1500,
        contentBottomRel: 1200,
      }),
    ).toBe(2000);
  });

  it("caps at five pages", () => {
    expect(
      growDrawHeight({
        basePageH: base,
        currentH: 4500,
        contentBottomRel: 4900,
      }),
    ).toBe(5000);
  });

  it("never drops below the initial draw height", () => {
    expect(
      growDrawHeight({
        basePageH: base,
        currentH: 900,
        contentBottomRel: DRAW_HEADER_BAND,
      }),
    ).toBe(1500);
  });
});

describe("contentBottomInFrame", () => {
  const frame = { x: 0, y: 0, width: 1000, height: 2000 };

  it("ignores pinned header text", () => {
    const bottom = contentBottomInFrame(
      [
        {
          id: "lcregion-approach-label",
          type: "text",
          x: 36,
          y: 24,
          width: 800,
          height: 40,
          customData: { lcRegion: "approach", lcPinnedHeader: true },
        },
        {
          id: "stroke-1",
          type: "freedraw",
          x: 100,
          y: 200,
          width: 50,
          height: 80,
          customData: { lcRegion: "approach" },
        },
      ],
      [],
      frame,
    );
    expect(bottom).toBe(280);
  });
});
