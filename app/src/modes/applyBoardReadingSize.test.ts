import { describe, expect, it } from "vitest";

import { applyBoardReadingSize, type ReadingElement } from "./applyBoardReadingSize";

function text(
  id: string,
  opts: {
    fontSize: number;
    y: number;
    oy: number;
    height?: number;
    fixed?: boolean;
    text?: string;
  },
): ReadingElement {
  return {
    id,
    type: "text",
    x: 36,
    y: opts.y,
    width: 400,
    height: opts.height ?? opts.fontSize * 1.4,
    fontSize: opts.fontSize,
    text: opts.text ?? "hello",
    customData: {
      lcRegion: "constraints",
      lcRegionOx: 36,
      lcRegionOy: opts.oy,
      ...(opts.fixed ? { lcFixedSize: true } : {}),
    },
  };
}

function withBodyBase(el: ReadingElement, base = 28): ReadingElement {
  return {
    ...el,
    customData: {
      ...el.customData,
      lcFontBase: base,
      lcLineHeightBase: 40 / 28,
      lcRegionOyBase: el.customData?.lcRegionOy,
    },
  };
}

describe("applyBoardReadingSize", () => {
  it("scales body only — title and tags stay put", () => {
    const elements: ReadingElement[] = [
      {
        id: "lcregion-constraints-frame",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 1000,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      text("lcregion-constraints-title", { fontSize: 56, y: 64, oy: 64, height: 70 }),
      text("lcregion-constraints-meta-0", {
        fontSize: 26,
        y: 150,
        oy: 150,
        fixed: true,
      }),
      withBodyBase(
        text("lcregion-constraints-body-0", {
          fontSize: 28,
          y: 200,
          oy: 200,
          height: 40,
          text: "line one",
        }),
      ),
      withBodyBase(
        text("lcregion-constraints-body-1", {
          fontSize: 28,
          y: 280,
          oy: 280,
          height: 40,
          text: "line two",
        }),
      ),
    ];

    const large = applyBoardReadingSize(elements, "L");
    const title = large.find((el) => el.id.endsWith("-title"))!;
    const meta = large.find((el) => el.id.includes("-meta-"))!;
    const body0 = large.find((el) => el.id.endsWith("-body-0"))!;
    const body1 = large.find((el) => el.id.endsWith("-body-1"))!;

    expect(title.fontSize).toBe(56);
    expect(title.y).toBe(64);
    expect(meta.fontSize).toBe(26);
    expect(meta.y).toBe(150);

    expect(body0.fontSize).toBe(44);
    expect(body0.y).toBe(200);
    expect(body1.y).toBeGreaterThan(body0.y!);
  });

  it("does not change body font when zoom changes", () => {
    const elements = [
      withBodyBase(
        text("lcregion-constraints-body-0", {
          fontSize: 28,
          y: 200,
          oy: 200,
          text: "hello",
        }),
      ),
    ];
    const a = applyBoardReadingSize(elements, "M", { zoom: 0.5 });
    const b = applyBoardReadingSize(elements, "M", { zoom: 1.5 });
    expect(a[0].fontSize).toBe(36);
    expect(b[0].fontSize).toBe(36);
  });
});
