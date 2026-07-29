import { describe, expect, it } from "vitest";

import {
  enforceVisibleDrawingCap,
  restoreMessageDrawing,
  setDrawingExpanded,
  visibleDrawings,
  withNewDrawing,
} from "./drawingState";
import type { VizProgram } from "./schema";

function program(id: string): VizProgram {
  return {
    viz: "array",
    id,
    title: id,
    frames: [{ label: "start", cells: [1], pointers: {}, highlight: [], entries: [], note: "" }],
  };
}

describe("drawingState", () => {
  it("marks new drawings expanded", () => {
    const drawing = withNewDrawing(program("a"));
    expect(drawing.expanded).toBe(true);
    expect(drawing.redacted).toBeUndefined();
  });

  it("redacts oldest when the visible cap is exceeded", () => {
    const messages = ["a", "b", "c", "d", "e"].map((id) => ({
      id: `m-${id}`,
      drawing: withNewDrawing(program(id)),
    }));
    const capped = enforceVisibleDrawingCap(messages, 4);
    expect(visibleDrawings(capped).map((d) => d.program.id)).toEqual(["b", "c", "d", "e"]);
    expect(capped[0].drawing?.redacted).toBe(true);
    expect(capped[0].drawing?.expanded).toBe(false);
  });

  it("expanding a redacted drawing clears redacted and may reclaim another slot", () => {
    let messages = ["a", "b", "c", "d"].map((id) => ({
      id: `m-${id}`,
      drawing: withNewDrawing(program(id)),
    }));
    messages = setDrawingExpanded(messages, "m-a", false);
    messages = messages.map((message) =>
      message.id === "m-a"
        ? { ...message, drawing: { ...message.drawing!, redacted: true } }
        : message,
    );
    messages.push({ id: "m-e", drawing: withNewDrawing(program("e")) });
    messages = enforceVisibleDrawingCap(messages, 4);
    const next = setDrawingExpanded(messages, "m-a", true);
    expect(next.find((m) => m.id === "m-a")?.drawing?.redacted).toBe(false);
    expect(visibleDrawings(next)).toHaveLength(4);
  });

  it("restores a stored drawing blob", () => {
    const restored = restoreMessageDrawing({
      program: program("nums"),
      expanded: true,
      redacted: false,
      frameIndex: 2,
    });
    expect(restored?.program.id).toBe("nums");
    expect(restored?.frameIndex).toBe(2);
    expect(restoreMessageDrawing({ program: { viz: "nope" } })).toBeUndefined();
  });
});
