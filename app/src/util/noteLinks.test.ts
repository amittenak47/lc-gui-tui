import { describe, expect, it } from "vitest";

import {
  edgeId,
  footnoteEdges,
  isUnresolved,
  makeEdge,
  nodeKey,
  sameNode,
  slugify,
  unresolvedNode,
  type NodeRef,
} from "./noteLinks";

const note: NodeRef = { type: "annotate", id: "mdink-1", title: "dp.md" };
const problem: NodeRef = { type: "practice", id: "leetcode/two-sum" };

describe("node identity", () => {
  it("matches on type and id, ignoring the denormalised title", () => {
    // Titles are decoration for the graph; two refs to one set are one node
    // even when they were captured under different names.
    expect(sameNode(note, { type: "annotate", id: "mdink-1", title: "Second pass" })).toBe(true);
    expect(sameNode(note, { type: "annotate", id: "mdink-2" })).toBe(false);
  });

  it("does not confuse one id across two types", () => {
    expect(sameNode({ type: "annotate", id: "x" }, { type: "whiteboard", id: "x" })).toBe(false);
    expect(nodeKey({ type: "annotate", id: "x" })).not.toBe(nodeKey({ type: "whiteboard", id: "x" }));
  });
});

describe("unresolved nodes", () => {
  it("marks a title that names nothing, keeping what was typed", () => {
    const node = unresolvedNode("Some Note");
    expect(node.id).toBe("unresolved:some-note");
    expect(node.title).toBe("Some Note");
    expect(isUnresolved(node)).toBe(true);
  });

  it("does not read a real set as unresolved", () => {
    expect(isUnresolved(note)).toBe(false);
  });

  it("slugs whitespace so two spellings land on one node", () => {
    expect(slugify("  Some   Note ")).toBe("some-note");
  });
});

describe("edgeId", () => {
  it("is stable, so the same link made twice is one row", () => {
    // Footnote lifts run on every open of a pad; a random id would stack a
    // fresh copy each time.
    expect(edgeId(note, problem, "wiki")).toBe(edgeId(note, problem, "wiki"));
  });

  it("separates the kinds", () => {
    // "I typed this" and "the app lifted it off a footnote" are different
    // claims and draw different lines on the atlas.
    expect(edgeId(note, problem, "wiki")).not.toBe(edgeId(note, problem, "picker"));
  });

  it("is directed", () => {
    expect(edgeId(note, problem, "wiki")).not.toBe(edgeId(problem, note, "wiki"));
  });

  it("ignores titles, which can change without the link changing", () => {
    expect(edgeId({ ...note, title: "renamed" }, problem, "wiki")).toBe(
      edgeId(note, problem, "wiki"),
    );
  });
});

describe("footnoteEdges", () => {
  const pad: NodeRef = { type: "annotate", id: "mdink-1", title: "dp.pdf" };

  it("lifts a coach thread, remembering which pad it lives on", () => {
    // A thread is not reachable on its own — opening one means opening the pad
    // and then the mark, so the parent has to travel with it.
    const edges = footnoteEdges(pad, [
      { id: "f1", threads: [{ rootId: "t-1", title: "Why n log n?" }] },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("footnote-thread");
    expect(edges[0]!.to).toEqual({
      type: "thread",
      id: "t-1",
      title: "Why n log n?",
      parent: { type: "annotate", id: "mdink-1" },
    });
  });

  it("lifts a saved URL, using the URL as the node", () => {
    // An external page has no library id to be named by.
    const edges = footnoteEdges(pad, [
      { id: "f1", userLinks: [{ url: "https://ex.com/a", title: "Ex" }] },
    ]);
    expect(edges[0]!.kind).toBe("footnote-url");
    expect(edges[0]!.to).toEqual({ type: "web", id: "https://ex.com/a", title: "Ex" });
  });

  it("is idempotent, because it runs on every open of the pad", () => {
    const footnotes = [{ id: "f1", threads: [{ rootId: "t-1", title: "T" }] }];
    const first = footnoteEdges(pad, footnotes);
    const again = footnoteEdges(pad, footnotes);
    expect(again.map((edge) => edge.id)).toEqual(first.map((edge) => edge.id));
  });

  it("collapses one thread reached from two marks", () => {
    const edges = footnoteEdges(pad, [
      { id: "f1", threads: [{ rootId: "t-1", title: "T" }] },
      { id: "f2", threads: [{ rootId: "t-1", title: "T" }] },
    ]);
    expect(edges).toHaveLength(1);
  });

  it("takes both kinds off one mark", () => {
    const edges = footnoteEdges(pad, [
      {
        id: "f1",
        threads: [{ rootId: "t-1", title: "T" }],
        userLinks: [{ url: "https://ex.com/a" }],
      },
    ]);
    expect(edges.map((edge) => edge.kind).sort()).toEqual(["footnote-thread", "footnote-url"]);
  });

  it("ignores marks with nothing on them, and blank targets", () => {
    expect(footnoteEdges(pad, [{ id: "f1" }])).toEqual([]);
    expect(footnoteEdges(pad, [{ id: "f1", threads: [{ rootId: "", title: "T" }] }])).toEqual([]);
    expect(footnoteEdges(pad, [{ id: "f1", userLinks: [{ url: "" }] }])).toEqual([]);
  });

  it("does not lift notes on a mark — they are not places to go", () => {
    const edges = footnoteEdges(pad, [
      { id: "f1", threads: [], userLinks: [] } as never,
    ]);
    expect(edges).toEqual([]);
  });
});

describe("makeEdge", () => {
  it("carries both ends, the kind, and when it was made", () => {
    const edge = makeEdge(note, problem, "ink", 1234);
    expect(edge).toEqual({
      id: edgeId(note, problem, "ink"),
      from: note,
      to: problem,
      kind: "ink",
      createdAt: 1234,
    });
  });
});
