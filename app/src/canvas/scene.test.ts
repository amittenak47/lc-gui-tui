/**
 * The Clear bug, pinned down.
 *
 * Reported symptom: pressing **Clear** erased the problem statement, not just
 * the student's strokes. Cause: `convertToExcalidrawElements` turns a bound
 * label into a *second* element with a generated id, so matching on id prefixes
 * missed every label in the template and treated it as student work.
 */

import { describe, expect, it } from "vitest";

import { buildProblemTemplate } from "../templates/problemBoard";
import { applyMetadata, isCoachElement, isTemplateElement, keepOnClear } from "./scene";

/** Stand-in for what `convertToExcalidrawElements` returns. */
function converted(
  entries: Array<{ id: string; containerId?: string; customData?: Record<string, string> | null }>,
) {
  return entries.map((entry) => ({ ...entry, type: "rectangle" }));
}

describe("applyMetadata", () => {
  it("keeps the metadata a skeleton asked for", () => {
    const sources = [{ id: "a", customData: { lcRegion: "approach" } }];
    const [element] = applyMetadata(converted([{ id: "a" }]), sources);
    expect(element.customData).toEqual({ lcRegion: "approach" });
  });

  it("gives a bound label its container's metadata", () => {
    // This is the actual bug: the label has a generated id and no customData.
    const sources = [{ id: "box", customData: { lcVizId: "nums" } }];
    const elements = applyMetadata(
      converted([{ id: "box" }, { id: "generated-9f3", containerId: "box" }]),
      sources,
    );
    expect(elements[1].customData).toEqual({ lcVizId: "nums" });
    expect(elements.every(isCoachElement)).toBe(true);
  });

  it("leaves untagged elements untagged", () => {
    const [element] = applyMetadata(converted([{ id: "stroke" }]), []);
    expect(element.customData).toBeUndefined();
  });

  it("applies a fallback when one is given", () => {
    const [element] = applyMetadata(converted([{ id: "x" }]), [], { lcVizId: "seen" });
    expect(element.customData).toEqual({ lcVizId: "seen" });
  });
});

describe("keepOnClear", () => {
  it("keeps the template and the coach's diagrams, drops the student's strokes", () => {
    const scene = [
      { id: "tmpl", customData: { lcRegion: "constraints" } },
      { id: "tmpl-label", customData: { lcRegion: "constraints" } },
      { id: "viz", customData: { lcVizId: "nums" } },
      { id: "my-stroke" },
      { id: "my-text", customData: null },
    ];
    expect(scene.filter(keepOnClear).map((e) => e.id)).toEqual(["tmpl", "tmpl-label", "viz"]);
  });

  it("survives a whole real template — including its bound labels", () => {
    const skeletons = buildProblemTemplate({
      taskId: "01-matrix",
      title: "01 Matrix",
      difficulty: "Medium",
      tags: ["Breadth-First Search"],
      description: "Given an m x n binary matrix mat, return the distance…",
      caseCount: 67,
    });

    // Simulate conversion: every skeleton becomes an element, and each labelled
    // container also yields a generated label element.
    const elements = skeletons.flatMap((skeleton, index) => {
      const own = { id: skeleton.id ?? `gen-${index}` };
      return skeleton.label
        ? [own, { id: `gen-label-${index}`, containerId: own.id }]
        : [own];
    });

    const tagged = applyMetadata(converted(elements), skeletons as never);
    expect(tagged.length).toBeGreaterThan(5);
    expect(tagged.every(isTemplateElement)).toBe(true);
    expect(tagged.filter(keepOnClear)).toHaveLength(tagged.length);

    // The regression: clearing must not remove any of it.
    const afterClear = [...tagged, { id: "student-stroke", type: "freedraw" }].filter(keepOnClear);
    expect(afterClear).toHaveLength(tagged.length);
  });
});
