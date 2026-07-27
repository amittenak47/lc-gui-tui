/**
 * Template legibility.
 *
 * Reported: "hard to read the template", "dont like this weird font". The
 * statement is reference material you stare at while sketching, so none of it
 * may be set in the hand-drawn face, and the parts full of brackets have to be
 * monospaced.
 */

import { describe, expect, it } from "vitest";

import { REGIONS } from "./regions";
import { buildProblemTemplate, parseStatement, recolorTemplateElements } from "./problemBoard";
import { FONT_CODE, FONT_UI, templatePalette } from "./skeleton";

const DESCRIPTION = `Given an m x n binary matrix mat, return the distance of the nearest 0 for each cell.
The distance between two cells sharing a common edge is 1.

Example 1:

Input: mat = [[0,0,0],[0,1,0],[0,0,0]]
Output: [[0,0,0],[0,1,0],[0,0,0]]

Constraints:

m == mat.length
n == mat[i].length
1 <= m, n <= 104
mat[i][j] is either 0 or 1.`;

describe("parseStatement", () => {
  it("sets bracket-heavy lines as code and prose as prose", () => {
    const blocks = parseStatement(DESCRIPTION);
    const prose = blocks.filter((block) => !block.code);
    const code = blocks.filter((block) => block.code);

    expect(prose.some((block) => block.text.includes("binary matrix"))).toBe(true);
    expect(code.some((block) => block.text.includes("[[0,0,0]"))).toBe(true);
    expect(code.some((block) => block.text.includes("1 <= m, n <= 104"))).toBe(true);
  });

  it("keeps the constraints, not just the opening lines", () => {
    const text = parseStatement(DESCRIPTION)
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("Constraints:");
    expect(text).toContain("mat[i][j] is either 0 or 1.");
  });

  it("handles a missing description without throwing", () => {
    expect(parseStatement(null)[0].text).toContain("no description");
    expect(parseStatement("")[0].text).toContain("no description");
  });
});

describe("buildProblemTemplate", () => {
  const skeletons = buildProblemTemplate({
    taskId: "01-matrix",
    title: "01 Matrix",
    difficulty: "Medium",
    tags: ["Breadth-First Search", "Array", "Dynamic Programming"],
    description: DESCRIPTION,
    caseCount: 67,
  });

  it("uses no hand-drawn font anywhere", () => {
    // Excalidraw font 1 is Virgil / 5 is Excalifont — both hand-drawn.
    const fonts = skeletons
      .map((skeleton) => skeleton.fontFamily)
      .filter((font): font is number => typeof font === "number");
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((font) => font === FONT_UI || font === FONT_CODE)).toBe(true);
  });

  it("monospaces the examples and constraints", () => {
    const body = skeletons.filter((s) => s.id?.startsWith("lcregion-constraints-body-"));
    const codeBlocks = body.filter((s) => s.fontFamily === FONT_CODE);
    expect(codeBlocks.length).toBeGreaterThan(0);
    expect(codeBlocks.some((s) => s.text?.includes("mat[i][j]"))).toBe(true);
  });

  it("gives the title and statement a readable size", () => {
    const title = skeletons.find((s) => s.id === "lcregion-constraints-title");
    expect(title?.fontSize).toBeGreaterThanOrEqual(48);
    const body = skeletons.filter((s) => s.id?.startsWith("lcregion-constraints-body-"));
    expect(body.every((s) => (s.fontSize ?? 0) >= 22)).toBe(true);
  });

  it("tags every element with its region, so Clear can keep them", () => {
    expect(skeletons.every((s) => Boolean(s.customData?.lcRegion))).toBe(true);
  });

  it("locks statement text but leaves region frames resizable", () => {
    const frames = skeletons.filter((s) => s.id?.endsWith("-frame"));
    const content = skeletons.filter((s) => !s.id?.endsWith("-frame"));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((s) => s.locked === false)).toBe(true);
    expect(content.every((s) => s.locked === true)).toBe(true);
    expect(frames.every((s) => s.customData?.lcRegionFrame)).toBe(true);
  });

  it("uses light ink on dark boards", () => {
    const dark = buildProblemTemplate({
      taskId: "01-matrix",
      title: "01 Matrix",
      description: "Given a matrix.",
      dark: true,
    });
    const title = dark.find((s) => s.id === "lcregion-constraints-title");
    expect(title?.strokeColor).toMatch(/^#f/i);
  });

  it("sets a wrap width on statement text", () => {
    const body = skeletons.filter((s) => s.id?.startsWith("lcregion-constraints-body-"));
    expect(body.every((s) => (s.width ?? 0) > 1000)).toBe(true);
  });
});

describe("recolorTemplateElements", () => {
  it("flips scaffold ink between light and dark without touching other ids", () => {
    const lightInk = templatePalette(false);
    const darkInk = templatePalette(true);
    const seeded = buildProblemTemplate({
      taskId: "01-matrix",
      title: "01 Matrix",
      description: "Given a matrix.",
      dark: true,
    }).map((skeleton) => ({
      id: skeleton.id!,
      type: skeleton.type,
      strokeColor: skeleton.strokeColor,
      fontFamily: skeleton.fontFamily,
      opacity: skeleton.opacity,
      customData: skeleton.customData ?? null,
    }));
    seeded.push({
      id: "student-stroke",
      type: "freedraw",
      strokeColor: "#ff00aa",
      fontFamily: undefined,
      opacity: 100,
      customData: null,
    });

    const light = recolorTemplateElements(seeded, false)!;
    const title = light.find((el) => el.id === "lcregion-constraints-title");
    const frame = light.find((el) => el.id === "lcregion-constraints-frame");
    const student = light.find((el) => el.id === "student-stroke");
    expect(title?.strokeColor).toBe(lightInk.primary);
    expect(frame?.strokeColor).toBe(lightInk.border);
    expect(student?.strokeColor).toBe("#ff00aa");

    const back = recolorTemplateElements(light, true)!;
    expect(back.find((el) => el.id === "lcregion-constraints-title")?.strokeColor).toBe(
      darkInk.primary,
    );
  });
});

describe("board size", () => {
  it("is roomy enough to sketch in", () => {
    // Reported: "size of the whiteboard larger".
    expect(REGIONS.constraints.w).toBeGreaterThanOrEqual(2000);
    expect(REGIONS.constraints.h).toBeGreaterThanOrEqual(1200);
    expect(REGIONS.approach.h).toBeGreaterThanOrEqual(1500);
    expect(REGIONS.complexity.h).toBeGreaterThanOrEqual(500);
    expect(REGIONS.walkthrough.h).toBeGreaterThanOrEqual(1200);
    expect(REGIONS.agent.w).toBeGreaterThanOrEqual(1200);
  });

  it("keeps the agent lane clear of the student's columns", () => {
    const student = REGIONS.constraints;
    expect(REGIONS.agent.x).toBeGreaterThan(student.x + student.w);
  });
});
