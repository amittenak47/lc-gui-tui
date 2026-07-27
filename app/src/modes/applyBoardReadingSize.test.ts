import { describe, expect, it } from "vitest";

import { applyBoardReadingSize, type ReadingElement } from "./applyBoardReadingSize";

function text(
  id: string,
  opts: { fontSize: number; y: number; oy: number; height?: number; fixed?: boolean },
): ReadingElement {
  return {
    id,
    type: "text",
    x: 36,
    y: opts.y,
    width: 400,
    height: opts.height ?? opts.fontSize * 1.4,
    fontSize: opts.fontSize,
    customData: {
      lcRegion: "constraints",
      lcRegionOx: 36,
      lcRegionOy: opts.oy,
      ...(opts.fixed ? { lcFixedSize: true } : {}),
    },
  };
}

describe("applyBoardReadingSize", () => {
  it("scales statement title and body fonts, not region labels or tags", () => {
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
      text("lcregion-constraints-label", { fontSize: 24, y: 24, oy: 24 }),
      text("lcregion-constraints-title", { fontSize: 56, y: 64, oy: 64, height: 70 }),
      text("lcregion-constraints-meta-0", {
        fontSize: 26,
        y: 150,
        oy: 150,
        fixed: true,
      }),
      text("lcregion-constraints-body-0", { fontSize: 28, y: 200, oy: 200, height: 40 }),
      text("lcregion-constraints-body-1", { fontSize: 28, y: 280, oy: 280, height: 40 }),
    ];

    const large = applyBoardReadingSize(elements, "L", { captureFrom: "M" });
    const label = large.find((el) => el.id.endsWith("-label"))!;
    const title = large.find((el) => el.id.endsWith("-title"))!;
    const meta = large.find((el) => el.id.includes("-meta-"))!;
    const body0 = large.find((el) => el.id.endsWith("-body-0"))!;
    const body1 = large.find((el) => el.id.endsWith("-body-1"))!;

    expect(label.fontSize).toBe(24);
    expect(label.y).toBe(24);
    expect(meta.fontSize).toBe(26);
    expect(meta.y).toBe(150);

    expect(title.fontSize).toBeCloseTo(71.3, 5);
    expect(title.y).toBe(64); // title does not move

    expect(body0.fontSize).toBeCloseTo(35.6, 5);
    expect(body0.y).toBe(200); // first body stays anchored
    expect(body1.y).toBeGreaterThan(280); // later bodies spread
  });

  it("is idempotent when re-applying the same size", () => {
    const elements: ReadingElement[] = [
      text("lcregion-constraints-body-0", { fontSize: 28, y: 200, oy: 200 }),
    ];
    const once = applyBoardReadingSize(elements, "S", { captureFrom: "M" });
    const twice = applyBoardReadingSize(once, "S", { captureFrom: "S" });
    expect(twice[0].fontSize).toBe(once[0].fontSize);
  });
});
