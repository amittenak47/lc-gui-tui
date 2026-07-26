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
import { buildProblemTemplate, parseStatement } from "./problemBoard";
import { FONT_CODE, FONT_UI } from "./skeleton";

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
    expect(title?.fontSize).toBeGreaterThanOrEqual(32);
    const body = skeletons.filter((s) => s.id?.startsWith("lcregion-constraints-body-"));
    expect(body.every((s) => (s.fontSize ?? 0) >= 16)).toBe(true);
  });

  it("tags every element with its region, so Clear can keep them", () => {
    expect(skeletons.every((s) => Boolean(s.customData?.lcRegion))).toBe(true);
  });

  it("locks the scaffolding so a stray palm can't drag the problem away", () => {
    expect(skeletons.every((s) => s.locked === true)).toBe(true);
  });

  it("keeps the statement inside its region", () => {
    const region = REGIONS.constraints;
    const body = skeletons.filter((s) => s.id?.startsWith("lcregion-constraints-"));
    for (const element of body) {
      expect(element.x).toBeGreaterThanOrEqual(region.x);
      expect(element.y).toBeGreaterThanOrEqual(region.y);
      expect(element.y).toBeLessThan(region.y + region.h);
    }
  });
});

describe("board size", () => {
  it("is roomy enough to sketch in", () => {
    // Reported: "size of the whiteboard larger".
    expect(REGIONS.constraints.w).toBeGreaterThanOrEqual(2000);
    expect(REGIONS.approach.h).toBeGreaterThanOrEqual(800);
    expect(REGIONS.agent.w).toBeGreaterThanOrEqual(800);
  });

  it("keeps the agent lane clear of the student's columns", () => {
    const student = REGIONS.constraints;
    expect(REGIONS.agent.x).toBeGreaterThan(student.x + student.w);
  });
});
