import { describe, expect, it } from "vitest";

import { clusterLabelPoints, layoutNodes } from "./ExploreWorkspace";
import type { NodeRef } from "../util/noteLinks";

const note = (id: string): NodeRef => ({ type: "annotate", id, title: id });
const board = (id: string): NodeRef => ({ type: "whiteboard", id, title: id });

describe("layoutNodes", () => {
  it("is deterministic, so the atlas can be learned", () => {
    // No force simulation and no randomness on purpose: a graph that settles
    // somewhere different every time it opens cannot be remembered.
    const nodes = [note("a"), note("b"), board("c")];
    expect(layoutNodes(nodes)).toEqual(layoutNodes(nodes));
  });

  it("puts a lone node at its cluster's centre rather than orbiting it", () => {
    const [placed] = layoutNodes([note("only")]);
    const [other] = layoutNodes([note("different")]);
    expect(placed!.x).toBe(other!.x);
    expect(placed!.y).toBe(other!.y);
  });

  it("keeps the kinds apart", () => {
    const placed = layoutNodes([note("a"), board("b")]);
    const notes = placed.find((entry) => entry.node.type === "annotate")!;
    const boards = placed.find((entry) => entry.node.type === "whiteboard")!;
    expect(Math.abs(notes.x - boards.x)).toBeGreaterThan(100);
  });

  it("places every node it is given", () => {
    const nodes = [note("a"), note("b"), note("c"), board("d"), { type: "practice", id: "leetcode/two-sum" } as NodeRef];
    expect(layoutNodes(nodes)).toHaveLength(nodes.length);
  });

  it("spreads a cluster rather than stacking it on one point", () => {
    const placed = layoutNodes([note("a"), note("b"), note("c")]);
    const points = new Set(placed.map((entry) => `${Math.round(entry.x)},${Math.round(entry.y)}`));
    expect(points.size).toBe(3);
  });

  it("grows the ring so a large cluster does not overlap itself", () => {
    const small = layoutNodes([note("a"), note("b")]);
    const big = layoutNodes(Array.from({ length: 12 }, (_, i) => note(`n${i}`)));
    const spread = (rows: ReturnType<typeof layoutNodes>) =>
      Math.max(...rows.map((row) => row.x)) - Math.min(...rows.map((row) => row.x));
    expect(spread(big)).toBeGreaterThan(spread(small));
  });

  it("centres a lone cluster instead of leaving the canvas empty", () => {
    // Fixed per-kind centres put notes and whiteboards both in the upper band
    // and wasted two thirds of the page. The grid is over the kinds present.
    const [only] = layoutNodes([note("a")]);
    expect(only!.x).toBeGreaterThan(400);
    expect(only!.x).toBeLessThan(600);
    expect(only!.y).toBeGreaterThan(260);
    expect(only!.y).toBeLessThan(380);
  });

  it("moves a kind only when the set of kinds changes", () => {
    const withBoard = layoutNodes([note("a"), board("b")]);
    const alsoBoard = layoutNodes([note("a"), note("c"), board("b")]);
    const first = (rows: ReturnType<typeof layoutNodes>) =>
      rows.find((row) => row.node.type === "whiteboard")!;
    // Same two kinds, so the whiteboard cell is unchanged even though the
    // notes cluster grew.
    expect(first(alsoBoard).x).toBe(first(withBoard).x);
  });

  it("puts a label above every populated cluster and none above an empty one", () => {
    const labels = clusterLabelPoints([note("a"), board("b")]);
    expect(labels.map((entry) => entry.type)).toEqual(["annotate", "whiteboard"]);
    const placed = layoutNodes([note("a"), board("b")]);
    for (const label of labels) {
      const top = Math.min(
        ...placed.filter((row) => row.node.type === label.type).map((row) => row.y),
      );
      expect(label.y).toBeLessThan(top);
    }
  });

  it("draws nothing for an empty library", () => {
    expect(layoutNodes([])).toEqual([]);
  });

  it("ignores a kind it has no cluster for", () => {
    // Threads have a cluster; an invented type must not land at 0,0.
    expect(layoutNodes([{ type: "nonsense" as NodeRef["type"], id: "x" }])).toEqual([]);
  });
});
