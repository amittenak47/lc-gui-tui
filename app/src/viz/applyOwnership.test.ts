import { describe, expect, it } from "vitest";

import { studentElements } from "../canvas/capture";
import { isCoachElement, isTemplateElement } from "../canvas/scene";
import { mergeVizElements } from "./apply";

describe("coach overlay ownership", () => {
  it("counts highlight overlays as the coach's, and strips them from capture", () => {
    const highlight = {
      id: "h1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      version: 1,
      customData: { lcVizId: "highlight:0" },
    };
    const student = {
      id: "s1",
      type: "text",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      version: 1,
      customData: null,
    };
    const template = {
      id: "t1",
      customData: { lcRegion: "approach" },
    };

    expect(isTemplateElement(highlight)).toBe(false);
    expect(isTemplateElement(student)).toBe(false);
    expect(isTemplateElement(template)).toBe(true);

    expect(isCoachElement(highlight)).toBe(true);
    expect(studentElements([student, highlight]).map((el) => el.id)).toEqual(["s1"]);
  });

  it("mergeVizElements replaces one group without touching another", () => {
    const existing = [
      { id: "a1", customData: { lcVizId: "prog-a" } },
      { id: "b1", customData: { lcVizId: "prog-b" } },
    ];
    const next = mergeVizElements(existing, [{ id: "a2", customData: { lcVizId: "prog-a" } }], "prog-a");
    expect(next.map((el) => (el as { id: string }).id)).toEqual(["b1", "a2"]);
  });
});
