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
import { READING_COLUMN_MAX, readingColumnWidth } from "./readingColumn";
import { FONT_UI, templatePalette } from "./skeleton";

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

  it("renders markdown fences as monospace without showing the markers", () => {
    const blocks = parseStatement(`Returns values above the mean.

\`\`\`python
above_average([1, 2, 3, 4, 5])
[4, 5]
\`\`\`

Keep relative order.`);
    const joined = blocks.map((block) => block.text).join("\n");
    expect(joined).not.toContain("```");
    expect(joined).toContain("above_average([1, 2, 3, 4, 5])");
    const code = blocks.filter((block) => block.code);
    expect(code.some((block) => block.text.includes("above_average"))).toBe(true);
    expect(blocks.some((block) => !block.code && block.text.includes("relative order"))).toBe(
      true,
    );
  });

  it("treats doctest arrows as code", () => {
    const blocks = parseStatement(`Compute the average.

>>> above_average([1, 2, 3])
[3]`);
    expect(blocks.some((block) => block.code && block.text.includes(">>>"))).toBe(true);
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

  it("seeds only region frames — statement prose is HTML", () => {
    expect(skeletons.every((s) => s.id?.endsWith("-frame"))).toBe(true);
    expect(skeletons.some((s) => s.id?.includes("-title"))).toBe(false);
    expect(skeletons.some((s) => s.id?.includes("-body-"))).toBe(false);
    expect(skeletons.some((s) => s.id?.includes("-meta-"))).toBe(false);
  });

  it("sizes the statement column to the screen it will be read on", () => {
    const phone = buildProblemTemplate({
      taskId: "01-matrix",
      title: "01 Matrix",
      description: "Given a matrix.",
      viewportWidth: 400,
    }).find((s) => s.id === "lcregion-constraints-frame");
    const tablet = buildProblemTemplate({
      taskId: "01-matrix",
      title: "01 Matrix",
      description: "Given a matrix.",
      viewportWidth: 1400,
    }).find((s) => s.id === "lcregion-constraints-frame");

    expect(phone?.width).toBe(readingColumnWidth(400));
    expect(phone?.width).toBeLessThan(400);
    expect(tablet?.width).toBe(READING_COLUMN_MAX);
    expect(phone?.customData?.lcDocumentPage).toBe(true);
    expect(phone?.customData?.lcReadingColumn).toBe(true);
  });

  it("tags every element with its region, so Clear can keep them", () => {
    expect(skeletons.every((s) => Boolean(s.customData?.lcRegion))).toBe(true);
  });

  it("draws no region chrome — no boxes, no labels, no hints", () => {
    const frames = skeletons.filter((s) => s.id?.endsWith("-frame"));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((s) => s.strokeWidth === 0)).toBe(true);
    expect(frames.every((s) => s.strokeColor === "transparent")).toBe(true);
    expect(frames.every((s) => s.opacity === 0)).toBe(true);
    expect(frames.every((s) => s.locked === true)).toBe(true);
    expect(frames.every((s) => s.customData?.lcRegionFrame)).toBe(true);

    expect(skeletons.some((s) => s.id?.endsWith("-label"))).toBe(false);
    expect(skeletons.some((s) => s.id?.endsWith("-hint"))).toBe(false);
  });

  it("draws nothing for scaffolding it is handed", () => {
    const custom = buildProblemTemplate({
      taskId: "two-sum",
      title: "Two Sum",
      scaffolding: {
        approach: "What do you need to look up in O(1)?",
        complexity: "time ___ · space ___",
        walkthrough: "Trace nums = [2,7,11] target = 9",
      },
    });
    expect(custom.some((s) => s.text?.includes("O(1)"))).toBe(false);
    expect(custom.some((s) => s.id?.includes("-hint"))).toBe(false);
  });
});

describe("recolorTemplateElements", () => {
  it("flips scaffold ink between light and dark without touching other ids", () => {
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

    const light = recolorTemplateElements(seeded, false) ?? seeded;
    const frame = light.find((el) => el.id === "lcregion-constraints-frame");
    const student = light.find((el) => el.id === "student-stroke");
    // A frame is never given a stroke by a theme change — that repaint is what
    // used to bring every page's dashed box back on screen at once.
    expect(frame?.strokeColor).toBe("transparent");
    expect(student?.strokeColor).toBe("#ff00aa");

    const back = recolorTemplateElements(light, true) ?? light;
    expect(back.find((el) => el.id === "lcregion-constraints-frame")?.strokeColor).toBe(
      "transparent",
    );
  });

  it("recolors region text even when conversion replaced lcregion ids", () => {
    const darkInk = templatePalette(true);
    const elements = [
      {
        id: "random-frame",
        type: "rectangle",
        strokeColor: "#14110e",
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      {
        id: "random-body",
        type: "text",
        strokeColor: "#1f1a14",
        fontFamily: FONT_UI,
        fontSize: 28,
        customData: { lcRegion: "constraints" },
      },
      {
        id: "random-title",
        type: "text",
        strokeColor: "#14110e",
        fontFamily: FONT_UI,
        fontSize: 56,
        customData: { lcRegion: "constraints" },
      },
      {
        id: "student-stroke",
        type: "freedraw",
        strokeColor: "#ff00aa",
        customData: null,
      },
    ];

    const next = recolorTemplateElements(elements, true)!;
    // Frames go the other way: a board saved when they were dashed loses the
    // boxes on its first restore, since `applyThemeInk` runs on every one.
    expect(next.find((el) => el.id === "random-frame")?.strokeColor).toBe("transparent");
    expect(
      (next.find((el) => el.id === "random-frame") as { strokeWidth?: number })?.strokeWidth,
    ).toBe(0);
    expect(next.find((el) => el.id === "random-body")?.strokeColor).toBe(darkInk.body);
    expect(next.find((el) => el.id === "random-title")?.strokeColor).toBe(darkInk.primary);
    expect(next.find((el) => el.id === "student-stroke")?.strokeColor).toBe("#ff00aa");
  });
});

describe("board size", () => {
  it("is roomy enough to sketch in", () => {
    // Reported: "size of the whiteboard larger". The statement is exempt: it
    // is a reading column sized to the screen, and "roomy" is the opposite of
    // what a measure wants.
    expect(REGIONS.approach.w).toBeGreaterThanOrEqual(2800);
    expect(REGIONS.approach.h).toBeGreaterThanOrEqual(2100);
    expect(REGIONS.complexity.h).toBeGreaterThanOrEqual(700);
    expect(REGIONS.walkthrough.h).toBeGreaterThanOrEqual(1680);
    expect(REGIONS.agent.w).toBeGreaterThanOrEqual(3500);
  });

  it("keeps the agent lane clear of the student's columns", () => {
    const student = REGIONS.approach;
    expect(REGIONS.agent.x).toBeGreaterThan(student.x + student.w);
  });
});
