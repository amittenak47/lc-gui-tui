import { describe, expect, it } from "vitest";

import { buildProblemTemplate } from "./problemBoard";
import { regionFrameId, syncRegionLayout } from "./regionLayout";
import { PAGE_BREAK, REGION_MIN, REGIONS } from "./regions";

function framesFromTemplate() {
  const skeletons = buildProblemTemplate({
    taskId: "01-matrix",
    title: "01 Matrix",
    description: "Given an array, return the sum.",
  });
  return skeletons.map((skeleton) => ({
    id: skeleton.id!,
    type: skeleton.type,
    x: skeleton.x,
    y: skeleton.y,
    width: skeleton.width,
    height: skeleton.height,
    customData: skeleton.customData ?? null,
  }));
}

/**
 * The shared student column — the statement is deliberately not in it.
 *
 * Constraints is a reading column sized to the viewport, not a desk that has
 * to match its neighbours, so a test that expected it to track the other
 * frames would be asserting the bug it used to have.
 */
function studentWidths(elements: { id: string; width?: number }[]) {
  return ["code", "approach", "complexity", "walkthrough"].map((region) => {
    const frame = elements.find((element) => element.id === regionFrameId(region as never));
    return frame?.width;
  });
}

describe("syncRegionLayout", () => {
  it("returns null when the default layout is already aligned", () => {
    expect(syncRegionLayout(framesFromTemplate())).toBeNull();
  });

  it("widens every student region when the code frame is resized", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.width = REGIONS.approach.w + 400;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const widths = studentWidths(synced!);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(REGIONS.approach.w + 400);
  });

  it("matches every student region when another column frame is widened", () => {
    const elements = framesFromTemplate();
    const approach = elements.find((element) => element.id === regionFrameId("approach"))!;
    approach.width = REGIONS.approach.w + 400;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const widths = studentWidths(synced!);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(REGIONS.approach.w + 400);
  });

  it("finds frames by customData even when ids were rewritten", () => {
    const elements = framesFromTemplate().map((element, index) =>
      element.customData?.lcRegionFrame
        ? { ...element, id: `excalidraw-frame-${index}` }
        : element,
    );
    const code = elements.find(
      (element) => element.customData?.lcRegion === "code" && element.customData?.lcRegionFrame,
    )!;
    code.width = REGIONS.approach.w + 250;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const studentFrames = synced!.filter((element) => element.customData?.lcRegionFrame);
    const studentWidthsOnly = studentFrames
      .filter(
        (element) =>
          element.customData?.lcRegion !== "agent" &&
          element.customData?.lcRegion !== "constraints",
      )
      .map((element) => element.width);
    expect(new Set(studentWidthsOnly).size).toBe(1);
    expect(studentWidthsOnly[0]).toBe(REGIONS.approach.w + 250);
  });

  it("reflows regions below a taller problem statement", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;
    constraints.height = REGIONS.constraints.h + 200;

    const synced = syncRegionLayout(elements)!;
    const code = synced.find((element) => element.id === regionFrameId("code"))!;
    const approach = synced.find((element) => element.id === regionFrameId("approach"))!;
    expect(code.y).toBe(constraints.height! + PAGE_BREAK);
    expect(approach.y).toBe(code.y + code.height! + PAGE_BREAK);
  });

  it("pins the statement frame to the top when resized from the top", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;

    // Simulate Excalidraw resizing from the top edge: frame moves down.
    // Statement prose is HTML under the canvas now, so there is no scene title
    // to re-pin — the frame itself still has to sit at y = 0.
    constraints.y = 180;
    constraints.height = REGIONS.constraints.h - 180;

    const synced = syncRegionLayout(elements)!;
    const nextConstraints = synced.find((element) => element.id === regionFrameId("constraints"))!;
    expect(nextConstraints.y).toBe(0);
    expect(nextConstraints.height).toBeGreaterThanOrEqual(REGION_MIN.constraints.minH);
  });

  it("enforces a minimum height when a frame is shrunk too far", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.height = 40;

    const synced = syncRegionLayout(elements)!;
    const nextCode = synced.find((element) => element.id === regionFrameId("code"))!;
    expect(nextCode.height).toBeGreaterThanOrEqual(320);
  });

  it("sizes the code frame to the solution content height", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.height = 560;

    const synced = syncRegionLayout(elements, { codeContentHeight: 1800 })!;
    const nextCode = synced.find((element) => element.id === regionFrameId("code"))!;
    expect(nextCode.height).toBe(1800);
    const approach = synced.find((element) => element.id === regionFrameId("approach"))!;
    expect(approach.y).toBe(nextCode.y + nextCode.height! + PAGE_BREAK);
  });

  it("lets the student keep a code frame taller than the content", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.height = 2400;

    const synced = syncRegionLayout(elements, { codeContentHeight: 900 })!;
    const nextCode = synced.find((element) => element.id === regionFrameId("code"))!;
    expect(nextCode.height).toBe(2400);
  });

  it("will not shrink the problem frame below its floor", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;
    constraints.height = 120;

    const synced = syncRegionLayout(elements)!;
    const next = synced.find((element) => element.id === regionFrameId("constraints"))!;
    expect(next.height).toBeGreaterThanOrEqual(REGION_MIN.constraints.minH);
  });

  it("enforces a minimum shared student column width", () => {
    const elements = framesFromTemplate();
    for (const region of ["constraints", "code", "approach", "complexity", "walkthrough"] as const) {
      const frame = elements.find((element) => element.id === regionFrameId(region))!;
      frame.width = 200;
    }

    const synced = syncRegionLayout(elements)!;
    const widths = ["code", "approach"].map((region) => {
      return synced.find((element) => element.id === regionFrameId(region as never))?.width;
    });
    expect(widths.every((width) => (width ?? 0) >= 1680)).toBe(true);
  });

  it("does not drag the statement column out to the student width", () => {
    const elements = framesFromTemplate();
    const statement = elements.find((element) => element.id === regionFrameId("constraints"))!;
    const authored = statement.width!;
    const approach = elements.find((element) => element.id === regionFrameId("approach"))!;
    approach.width = REGIONS.approach.w + 600;

    const synced = syncRegionLayout(elements)!;
    const next = synced.find((element) => element.id === regionFrameId("constraints"))!;
    // Widening a drawing page is not a request to widen the measure you read.
    expect(next.width).toBe(authored);
  });

  it("re-widths the statement column when a caller supplies one", () => {
    const elements = framesFromTemplate();
    const synced = syncRegionLayout(elements, { readingColumnWidth: 420 })!;
    const statement = synced.find((element) => element.id === regionFrameId("constraints"))!;
    expect(statement.width).toBe(420);
  });

  it("keeps the coach lane beside the shared student column", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.width = REGIONS.approach.w + 300;

    const synced = syncRegionLayout(elements)!;
    const agent = synced.find((element) => element.id === regionFrameId("agent"))!;
    expect(agent.x).toBe(REGIONS.approach.w + 300 + 128);
    expect(agent.y).toBe(0);
  });

  it("does not stretch the Coach page to the student stack", () => {
    const elements = framesFromTemplate();
    const agent = elements.find((element) => element.id === regionFrameId("agent"))!;
    agent.height = REGION_MIN.agent.minH;

    const synced = syncRegionLayout(elements);
    const next = (synced ?? elements).find((element) => element.id === regionFrameId("agent"))!;
    expect(next.height).toBe(REGION_MIN.agent.minH);
  });
});
