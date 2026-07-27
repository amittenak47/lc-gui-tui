import { describe, expect, it } from "vitest";

import { buildProblemTemplate } from "./problemBoard";
import { regionFrameId, syncRegionLayout } from "./regionLayout";
import { REGIONS } from "./regions";

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

function studentWidths(elements: { id: string; width?: number }[]) {
  return ["constraints", "code", "approach", "complexity", "walkthrough"].map((region) => {
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
    code.width = REGIONS.constraints.w + 400;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const widths = studentWidths(synced!);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(REGIONS.constraints.w + 400);
  });

  it("matches every student region when another column frame is widened", () => {
    const elements = framesFromTemplate();
    const approach = elements.find((element) => element.id === regionFrameId("approach"))!;
    approach.width = REGIONS.constraints.w + 400;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const widths = studentWidths(synced!);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(REGIONS.constraints.w + 400);
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
    code.width = REGIONS.constraints.w + 250;

    const synced = syncRegionLayout(elements);
    expect(synced).not.toBeNull();

    const studentFrames = synced!.filter((element) => element.customData?.lcRegionFrame);
    const studentWidthsOnly = studentFrames
      .filter((element) => element.customData?.lcRegion !== "agent")
      .map((element) => element.width);
    expect(new Set(studentWidthsOnly).size).toBe(1);
    expect(studentWidthsOnly[0]).toBe(REGIONS.constraints.w + 250);
  });

  it("reflows regions below a taller problem statement", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;
    constraints.height = REGIONS.constraints.h + 200;

    const synced = syncRegionLayout(elements)!;
    const code = synced.find((element) => element.id === regionFrameId("code"))!;
    const approach = synced.find((element) => element.id === regionFrameId("approach"))!;
    expect(code.y).toBe(constraints.height! + 64);
    expect(approach.y).toBe(code.y + code.height! + 64);
  });

  it("keeps statement text inside the frame when resized from the top", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;
    const title = elements.find((element) => element.id === "lcregion-constraints-title")!;
    const titleOy = title.customData?.lcRegionOy ?? 64;

    // Simulate Excalidraw resizing from the top edge: frame moves down, text stays.
    constraints.y = 180;
    constraints.height = REGIONS.constraints.h - 180;

    const synced = syncRegionLayout(elements)!;
    const nextConstraints = synced.find((element) => element.id === regionFrameId("constraints"))!;
    const nextTitle = synced.find((element) => element.id === "lcregion-constraints-title")!;
    expect(nextConstraints.y).toBe(0);
    expect(nextTitle.y).toBe(nextConstraints.y + titleOy);
    expect(nextTitle.y).toBeGreaterThanOrEqual(nextConstraints.y);
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
    expect(approach.y).toBe(nextCode.y + nextCode.height! + 64);
  });

  it("lets the student keep a code frame taller than the content", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.height = 2400;

    const synced = syncRegionLayout(elements, { codeContentHeight: 900 })!;
    const nextCode = synced.find((element) => element.id === regionFrameId("code"))!;
    expect(nextCode.height).toBe(2400);
  });

  it("will not shrink the problem frame below its statement content", () => {
    const elements = framesFromTemplate();
    const constraints = elements.find((element) => element.id === regionFrameId("constraints"))!;
    const body = elements.filter((element) => element.id.startsWith("lcregion-constraints-body-"));
    expect(body.length).toBeGreaterThan(0);
    constraints.height = 120;

    const synced = syncRegionLayout(elements)!;
    const next = synced.find((element) => element.id === regionFrameId("constraints"))!;
    expect(next.height).toBeGreaterThan(400);
  });

  it("enforces a minimum shared student column width", () => {
    const elements = framesFromTemplate();
    for (const region of ["constraints", "code", "approach", "complexity", "walkthrough"] as const) {
      const frame = elements.find((element) => element.id === regionFrameId(region))!;
      frame.width = 200;
    }

    const synced = syncRegionLayout(elements)!;
    const widths = ["constraints", "code", "approach"].map((region) => {
      return synced.find((element) => element.id === regionFrameId(region as never))?.width;
    });
    expect(widths.every((width) => (width ?? 0) >= 1200)).toBe(true);
  });

  it("keeps the coach lane beside the shared student column", () => {
    const elements = framesFromTemplate();
    const code = elements.find((element) => element.id === regionFrameId("code"))!;
    code.width = REGIONS.constraints.w + 300;

    const synced = syncRegionLayout(elements)!;
    const agent = synced.find((element) => element.id === regionFrameId("agent"))!;
    expect(agent.x).toBe(REGIONS.constraints.w + 300 + 128);
    expect(agent.y).toBe(0);
  });
});
