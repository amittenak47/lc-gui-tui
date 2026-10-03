import { describe, expect, it } from "vitest";

import { agentSlotOrigin } from "../../templates/regions";
import { edgesHaveCycle, parseVizProgram, resolveNodeEdges, type VizKind } from "../schema";
import { renderViz } from "./index";

const ORIGIN = agentSlotOrigin(0);

function draw(viz: VizKind, cells: unknown[], entries: unknown[]) {
  const program = parseVizProgram({ viz, id: `${viz}-t`, title: "t", frames: [{ label: "s", cells, entries }] })!;
  const elements = renderViz(program, 0, ORIGIN);
  const edges = elements.filter((e) => /edge-\d+/.test(e.id ?? "") && e.type === "arrow");
  const nodes = elements.filter((e) => /node-\d+$/.test(e.id ?? "") && e.type === "rectangle");
  const nodeY = (i: number) => {
    const node = nodes.find((e) => (e.id ?? "").endsWith(`node-${i}`))!;
    return node.y + (node.height ?? 0) / 2;
  };
  return { edges, nodes, nodeY };
}

describe("resolveNodeEdges", () => {
  it("reads edges named by node value", () => {
    expect(resolveNodeEdges([5, 3, 8, 1], [[5, 3], [5, 8], [3, 1]])).toEqual([[0, 1], [0, 2], [1, 3]]);
    expect(resolveNodeEdges(["A", "B", "C"], ["A -> B", { from: "A", to: "C" }])).toEqual([[0, 1], [0, 2]]);
  });

  it("reads edges named by position when values do not match", () => {
    expect(resolveNodeEdges(["f(3)", "f(2)", "f(1)"], [[0, 1], [1, 2]])).toEqual([[0, 1], [1, 2]]);
  });

  it("prefers the reading that connects more of the list", () => {
    // By position, 4 is past the end; by value every edge lands.
    expect(resolveNodeEdges([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]])).toEqual([[0, 1], [0, 2], [2, 3]]);
  });
});

describe("edgesHaveCycle", () => {
  it("treats u→v and v→u as one link", () => {
    expect(edgesHaveCycle(3, [[0, 1], [1, 0], [1, 2]])).toBe(false);
    expect(edgesHaveCycle(3, [[0, 1], [1, 2], [2, 0]])).toBe(true);
  });
});

describe("connected trees and graphs", () => {
  it("connects an n-ary tree whose edges name nodes by value", () => {
    const { edges, nodeY } = draw("tree", [10, 4, 7, 2, 9], [[10, 4], [10, 7], [10, 2], [7, 9]]);
    expect(edges).toHaveLength(4);
    expect(nodeY(1)).toBeGreaterThan(nodeY(0));
    expect(nodeY(4)).toBeGreaterThan(nodeY(2));
  });

  it("lays out a tree sent as `graph` in levels, not on a ring", () => {
    const { edges, nodeY } = draw("graph", ["A", "B", "C", "D", "E"], [["A", "B"], ["A", "C"], ["B", "D"], ["B", "E"]]);
    expect(edges).toHaveLength(4);
    expect(nodeY(1)).toBe(nodeY(2));
    expect(nodeY(3)).toBe(nodeY(4));
    expect(nodeY(3)).toBeGreaterThan(nodeY(1));
  });

  it("keeps a graph with a cycle on its ring, every edge drawn", () => {
    const { edges } = draw("graph", ["A", "B", "C"], [["A", "B"], ["B", "C"], ["C", "A"]]);
    expect(edges).toHaveLength(3);
  });
});
