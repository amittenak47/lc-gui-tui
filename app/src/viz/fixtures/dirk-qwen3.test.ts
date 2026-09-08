/**
 * Golden programs for Dirk-Qwen3.8-27B. No live LLM in CI.
 */

import { describe, expect, it } from "vitest";

import { agentSlotOrigin } from "../../templates/regions";
import { renderViz } from "../render";
import { parseVizProgram } from "../schema";
import {
  DIRK_EDIT_DISTANCE_ONE_STEP,
  DIRK_TRIE_APP_APPLE,
  DIRK_UNION_1_2_FIND_2,
} from "./dirk-qwen3";

const ORIGIN = agentSlotOrigin(0);

function textsOf(elements: ReturnType<typeof renderViz>): string[] {
  return elements
    .flatMap((element) => [element.text, element.label?.text])
    .filter((text): text is string => typeof text === "string");
}

describe("Dirk trie for app/apple", () => {
  const program = parseVizProgram(DIRK_TRIE_APP_APPLE)!;

  it("parses as a trie with parent→child links, not heap indices", () => {
    expect(program.viz).toBe("trie");
    expect(program.frames[0]!.cells).toHaveLength(6);
    expect(program.frames[0]!.entries).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });

  it("draws every node and the chain of edges", () => {
    const elements = renderViz(program, 0, ORIGIN);
    expect(elements.some((el) => el.id?.endsWith("node-5"))).toBe(true);
    expect(elements.filter((el) => el.type === "arrow").length).toBe(5);
    const texts = textsOf(elements);
    expect(texts.some((text) => text.includes("e"))).toBe(true);
    expect(elements.every((el) => el.customData?.lcVizId === program.id)).toBe(true);
  });
});

describe("Dirk union(1,2) then find(2)", () => {
  const program = parseVizProgram(DIRK_UNION_1_2_FIND_2)!;

  it("parses three frames of parent[]", () => {
    expect(program.viz).toBe("unionfind");
    expect(program.frames).toHaveLength(3);
    expect(program.frames[1]!.cells).toEqual([0, 1, 1]);
    expect(program.frames[2]!.highlight).toEqual([2]);
  });

  it("draws the forest and reuses node ids across the find", () => {
    const unioned = renderViz(program, 1, ORIGIN);
    const found = renderViz(program, 2, ORIGIN);
    expect(unioned.some((el) => el.id?.endsWith("node-2"))).toBe(true);
    const firstIds = new Set(unioned.map((el) => el.id));
    expect(found.filter((el) => firstIds.has(el.id)).length).toBeGreaterThan(0);
    expect(found.find((el) => el.id?.endsWith("node-2"))?.strokeWidth).toBe(2);
  });
});

describe("Dirk edit-distance table one step", () => {
  const program = parseVizProgram(DIRK_EDIT_DISTANCE_ONE_STEP)!;

  it("parses a grid with axis labels", () => {
    expect(program.viz).toBe("dptable");
    expect(program.frames[0]!.cells).toHaveLength(4);
    expect(program.frames[0]!.entries[0]).toEqual(["", "c", "u", "t"]);
    expect(program.frames[0]!.highlight).toEqual([10]);
  });

  it("renders axis headers and highlights the current cell", () => {
    const elements = renderViz(program, 0, ORIGIN);
    const texts = textsOf(elements);
    expect(texts).toContain("c");
    expect(texts).toContain("u");
    expect(texts).toContain("a");
    const current = elements.find((el) => el.id?.endsWith("cell-2-2"));
    expect(current?.strokeWidth).toBe(2);
  });
});
