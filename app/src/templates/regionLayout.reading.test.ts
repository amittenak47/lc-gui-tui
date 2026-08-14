import { describe, expect, it } from "vitest";

import { buildAnnotateTemplate } from "./annotate";
import { isReadingColumnFrame } from "./regionLayout";
import type { LayoutElement } from "./regionLayout";

describe("isReadingColumnFrame", () => {
  it("does not treat md-ink frame as constraints reading column (heal path)", () => {
    const skeleton = buildAnnotateTemplate(800, false, 420)[0];
    const frame = {
      id: skeleton.id!,
      type: skeleton.type,
      x: skeleton.x,
      y: skeleton.y,
      width: skeleton.width,
      height: skeleton.height,
      customData: skeleton.customData ?? null,
    } as LayoutElement;
    expect(isReadingColumnFrame(frame)).toBe(false);
  });
});
