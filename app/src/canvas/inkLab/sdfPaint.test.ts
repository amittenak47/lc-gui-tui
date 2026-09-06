import { describe, expect, it } from "vitest";

import { paintSdfSpine } from "./sdfPaint";

describe("paintSdfSpine", () => {
  it("returns false when getTransform is missing so tiles can fall back", () => {
    const ctx = {
      canvas: { width: 64, height: 64 },
    } as unknown as CanvasRenderingContext2D;
    expect(paintSdfSpine(ctx, [{ x: 1, y: 1, r: 1 }], null)).toBe(false);
  });
});
