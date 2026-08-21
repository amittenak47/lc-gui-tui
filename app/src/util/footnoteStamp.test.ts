import { describe, expect, it } from "vitest";

import {
  sanitizeFootnotes,
  stampFootnoteEdits,
  type DocFootnote,
} from "./docFootnotes";

const mark = (over: Partial<DocFootnote> = {}): DocFootnote => ({
  id: "fn-1",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 4 },
  excerpt: "Hash",
  createdAt: 1_000,
  ...over,
});

describe("stampFootnoteEdits", () => {
  it("stamps a mark whose colour changed", () => {
    const before = [mark({ updatedAt: 1_000 })];
    const after = [mark({ updatedAt: 1_000, color: "#ff0000" })];
    const out = stampFootnoteEdits(before, after, 5_000);
    expect(out[0]!.updatedAt).toBe(5_000);
    // Its birthday is not its edit.
    expect(out[0]!.createdAt).toBe(1_000);
  });

  it("leaves a mark that did not change alone", () => {
    /*
     * Safe to run on every write, which is the point of stamping centrally: the
     * setter cannot know whether this particular update touched this particular
     * mark, so the comparison has to be the thing that decides.
     */
    const before = [mark({ updatedAt: 1_000 })];
    const after = [mark({ updatedAt: 1_000 })];
    expect(stampFootnoteEdits(before, after, 5_000)[0]!.updatedAt).toBe(1_000);
  });

  it("gives a new mark its creation time", () => {
    const out = stampFootnoteEdits([], [mark({ createdAt: 2_000 })], 5_000);
    expect(out[0]!.updatedAt).toBe(2_000);
  });

  it("does not invent a time for an old mark it has not seen edited", () => {
    // Everything written before the field existed. Making one up would be worse
    // than admitting there is not one.
    const untouched = mark();
    const out = stampFootnoteEdits([untouched], [untouched], 5_000);
    expect(out[0]!.updatedAt).toBeUndefined();
  });

  it("stamps that same old mark the moment it is edited", () => {
    const out = stampFootnoteEdits([mark()], [mark({ title: "Renamed" })], 5_000);
    expect(out[0]!.updatedAt).toBe(5_000);
  });

  it("notices a note being edited inside a mark", () => {
    const before = [
      mark({ notes: [{ id: "n1", text: "first", createdAt: 1, updatedAt: 1 }] }),
    ];
    const after = [
      mark({ notes: [{ id: "n1", text: "second", createdAt: 1, updatedAt: 2 }] }),
    ];
    expect(stampFootnoteEdits(before, after, 5_000)[0]!.updatedAt).toBe(5_000);
  });

  it("touches only the mark that changed", () => {
    const before = [mark({ id: "a", updatedAt: 1 }), mark({ id: "b", updatedAt: 1 })];
    const after = [mark({ id: "a", updatedAt: 1 }), mark({ id: "b", updatedAt: 1, title: "x" })];
    const out = stampFootnoteEdits(before, after, 5_000);
    expect(out.find((m) => m.id === "a")!.updatedAt).toBe(1);
    expect(out.find((m) => m.id === "b")!.updatedAt).toBe(5_000);
  });
});

describe("sanitizeFootnotes and updatedAt", () => {
  it("keeps a stored timestamp", () => {
    const [out] = sanitizeFootnotes([mark({ updatedAt: 4_321 })]);
    expect(out!.updatedAt).toBe(4_321);
  });

  it("drops one that is not a number", () => {
    // Stored JSON is untrusted; a string here would be a timestamp nothing can
    // compare against.
    const [out] = sanitizeFootnotes([{ ...mark(), updatedAt: "yesterday" }]);
    expect(out!.updatedAt).toBeUndefined();
  });

  it("leaves a mark that never had one without one", () => {
    const [out] = sanitizeFootnotes([mark()]);
    expect(out!.updatedAt).toBeUndefined();
  });
});
