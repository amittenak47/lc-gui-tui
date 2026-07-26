import { describe, expect, it } from "vitest";

import { cellText, entryPair, isVizKind, parseVizProgram } from "./schema";

describe("parseVizProgram", () => {
  it("accepts the shape from the plan", () => {
    const program = parseVizProgram({
      viz: "array",
      id: "nums",
      title: "two-pointer scan",
      frames: [
        {
          label: "i=0, j=3",
          cells: [2, 7, 11, 15],
          pointers: { i: 0, j: 3 },
          highlight: [0, 3],
          note: "sum = 17 > 9 → move j left",
        },
      ],
    });
    expect(program).toEqual({
      viz: "array",
      id: "nums",
      title: "two-pointer scan",
      frames: [
        {
          label: "i=0, j=3",
          cells: [2, 7, 11, 15],
          pointers: { i: 0, j: 3 },
          highlight: [0, 3],
          entries: [],
          note: "sum = 17 > 9 → move j left",
        },
      ],
    });
  });

  it("fills in the fields a small local model omits", () => {
    const program = parseVizProgram({ viz: "stack", id: "s", frames: [{}] })!;
    expect(program.title).toBe("");
    expect(program.frames[0]).toEqual({
      label: "",
      cells: [],
      pointers: {},
      highlight: [],
      entries: [],
      note: "",
    });
  });

  it("coerces pointer indices sent as strings", () => {
    const program = parseVizProgram({
      viz: "array",
      id: "a",
      frames: [{ pointers: { i: "2", j: 3, bad: "left" } }],
    })!;
    expect(program.frames[0].pointers).toEqual({ i: 2, j: 3 });
  });

  it("rejects a kind with no renderer", () => {
    expect(parseVizProgram({ viz: "hypercube", id: "x", frames: [{}] })).toBeNull();
  });

  it("rejects a program with no id or no frames", () => {
    expect(parseVizProgram({ viz: "array", frames: [{}] })).toBeNull();
    expect(parseVizProgram({ viz: "array", id: "a", frames: [] })).toBeNull();
    expect(parseVizProgram({ viz: "array", id: "", frames: [{}] })).toBeNull();
  });

  it("rejects non-objects rather than throwing", () => {
    for (const junk of [null, undefined, 42, "array", []]) {
      expect(parseVizProgram(junk)).toBeNull();
    }
  });

  it("drops malformed frames but keeps the good ones", () => {
    const program = parseVizProgram({
      viz: "array",
      id: "a",
      frames: [{ label: "ok" }, null, "junk", { label: "also ok" }],
    })!;
    expect(program.frames.map((f) => f.label)).toEqual(["ok", "also ok"]);
  });
});

describe("isVizKind", () => {
  it("recognizes the nine kinds the daemon advertises", () => {
    expect(isVizKind("linkedlist")).toBe(true);
    expect(isVizKind("trie")).toBe(false);
    expect(isVizKind(7)).toBe(false);
  });
});

describe("cellText", () => {
  it("renders scalars directly and null as a placeholder", () => {
    expect(cellText(7)).toBe("7");
    expect(cellText("x")).toBe("x");
    expect(cellText(true)).toBe("true");
    expect(cellText(null)).toBe("·");
    expect(cellText(undefined)).toBe("·");
  });

  it("falls back to JSON for anything structured", () => {
    expect(cellText([1, 2])).toBe("[1,2]");
  });
});

describe("entryPair", () => {
  it("reads pairs, objects, and arrow strings", () => {
    expect(entryPair([2, 0])).toEqual(["2", "0"]);
    expect(entryPair({ key: "a", value: 1 })).toEqual(["a", "1"]);
    expect(entryPair({ from: 0, to: 3 })).toEqual(["0", "3"]);
    expect(entryPair("0 -> 1")).toEqual(["0", "1"]);
  });

  it("returns null for anything it cannot read", () => {
    expect(entryPair(42)).toBeNull();
    expect(entryPair(["only-one"])).toBeNull();
    expect(entryPair({})).toBeNull();
  });
});
