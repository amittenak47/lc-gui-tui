import { describe, expect, it } from "vitest";

import { parseWikiRefs, resolveWikiLinks, resolveWikiRef, type WikiIndex } from "./wikiLinks";

const index: WikiIndex = {
  annotate: [
    { id: "mdink-1", name: "dp.md" },
    { id: "mdink-2", name: "dp.pdf", label: "Second pass" },
    { id: "mdink-3", name: "graphs.md" },
  ],
  whiteboards: [{ id: "nb-1", title: "Scratch" }],
  defaultDataset: "leetcode",
};

describe("parseWikiRefs", () => {
  it("finds a plain title", () => {
    expect(parseWikiRefs("see [[graphs]] for more")).toEqual([
      { raw: "graphs", scheme: null, target: "graphs" },
    ]);
  });

  it("reads the two schemes", () => {
    expect(parseWikiRefs("[[practice:two-sum]] and [[board:nb-1]]")).toEqual([
      { raw: "practice:two-sum", scheme: "practice", target: "two-sum" },
      { raw: "board:nb-1", scheme: "board", target: "nb-1" },
    ]);
  });

  it("collapses the same link typed twice", () => {
    expect(parseWikiRefs("[[graphs]] then [[Graphs]] again")).toHaveLength(1);
  });

  it("ignores brackets inside code", () => {
    // In a fence these are somebody's array indexing, not a link.
    expect(parseWikiRefs("```\nfoo[[bar]]\n```")).toEqual([]);
    expect(parseWikiRefs("use `a[[i]]` here")).toEqual([]);
  });

  it("still reads links either side of a fence", () => {
    const refs = parseWikiRefs("[[one]]\n```\n[[skipped]]\n```\n[[two]]");
    expect(refs.map((ref) => ref.target)).toEqual(["one", "two"]);
  });

  it("skips empty and unterminated brackets", () => {
    expect(parseWikiRefs("[[]] [[   ]] [[unclosed")).toEqual([]);
  });

  it("does not run a link across a line break", () => {
    expect(parseWikiRefs("[[start\nend]]")).toEqual([]);
  });

  it("skips a scheme with nothing after it", () => {
    expect(parseWikiRefs("[[practice:]]")).toEqual([]);
  });
});

describe("resolveWikiRef", () => {
  const ref = (raw: string) => parseWikiRefs(`[[${raw}]]`)[0]!;

  it("prefers a set's own label over a file name", () => {
    // The label is the name the reader chose; the file name is the one it
    // happened to arrive with.
    expect(resolveWikiRef(ref("Second pass"), index)).toEqual({
      type: "annotate",
      id: "mdink-2",
      title: "Second pass",
    });
  });

  it("matches a file name with or without its extension", () => {
    expect(resolveWikiRef(ref("dp.md"), index).id).toBe("mdink-1");
    expect(resolveWikiRef(ref("dp"), index).id).toBe("mdink-1");
  });

  it("falls back to a notebook title", () => {
    expect(resolveWikiRef(ref("Scratch"), index)).toEqual({
      type: "whiteboard",
      id: "nb-1",
      title: "Scratch",
    });
  });

  it("fills in the default dataset for a bare problem", () => {
    expect(resolveWikiRef(ref("practice:two-sum"), index).id).toBe("leetcode/two-sum");
    expect(resolveWikiRef(ref("practice:kodcode/foo"), index).id).toBe("kodcode/foo");
  });

  it("leaves an unknown title unresolved rather than creating a note", () => {
    // A typo must not silently become a library entry.
    const node = resolveWikiRef(ref("Nothing here"), index);
    expect(node.id).toBe("unresolved:nothing-here");
    expect(node.title).toBe("Nothing here");
  });

  it("keeps a board id that names no notebook, so the link still shows", () => {
    expect(resolveWikiRef(ref("board:gone"), index)).toEqual({
      type: "whiteboard",
      id: "gone",
      title: "gone",
    });
  });

  it("is case- and space-insensitive", () => {
    expect(resolveWikiRef(ref("  SECOND PASS  "), index).id).toBe("mdink-2");
  });
});

describe("resolveWikiLinks", () => {
  it("collapses two spellings of one target", () => {
    expect(resolveWikiLinks("[[dp]] and [[dp.md]]", index)).toHaveLength(1);
  });

  it("returns every distinct target", () => {
    const nodes = resolveWikiLinks("[[dp]] [[graphs]] [[practice:two-sum]] [[Scratch]]", index);
    expect(nodes.map((node) => node.type)).toEqual([
      "annotate",
      "annotate",
      "practice",
      "whiteboard",
    ]);
  });

  it("is empty for a note with no links", () => {
    expect(resolveWikiLinks("# Just a heading\n\nSome prose.", index)).toEqual([]);
  });
});
