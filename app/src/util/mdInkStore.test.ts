import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardBlob } from "../canvas/BoardHandle";
import {
  deleteMdInkDoc,
  findMdInkDocByHash,
  getMdInkDoc,
  hashMarkdown,
  listMdInkDocs,
  MD_INK_LIBRARY_LIMIT,
  MdInkLibraryFullError,
  restoreMdInkDoc,
  saveMdInkDoc,
  type MdInkDoc,
} from "./mdInkStore";

function board(mark = "a"): BoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
    ink: [],
  } as BoardBlob;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hashMarkdown", () => {
  it("is stable for the same text and different for a change", () => {
    expect(hashMarkdown("# Notes\n")).toBe(hashMarkdown("# Notes\n"));
    expect(hashMarkdown("# Notes\n")).not.toBe(hashMarkdown("# Notes!\n"));
  });

  it("separates texts of different length that would otherwise collide", () => {
    expect(hashMarkdown("")).not.toBe(hashMarkdown("\0"));
  });
});

describe("saveMdInkDoc", () => {
  it("updates the entry for markdown it has already seen", () => {
    const hash = hashMarkdown("# Notes");
    const first = saveMdInkDoc({ name: "notes.md", hash, source: "# Notes", board: board("one") });
    const second = saveMdInkDoc({ name: "notes.md", hash, source: "# Notes", board: board("two") });

    // The same document annotated twice is one library entry, not two.
    expect(second.id).toBe(first.id);
    expect(listMdInkDocs()).toHaveLength(1);
    expect(getMdInkDoc(first.id)?.board.elements).toEqual([{ id: "two" }]);
  });

  it("keeps annotations of different files apart", () => {
    saveMdInkDoc({ name: "a.md", hash: hashMarkdown("# A"), source: "# src", board: board("a") });
    saveMdInkDoc({ name: "b.md", hash: hashMarkdown("# B"), source: "# src", board: board("b") });
    expect(listMdInkDocs()).toHaveLength(2);
  });

  it("finds an annotation set by the markdown it was drawn over", () => {
    const hash = hashMarkdown("# Findable");
    const saved = saveMdInkDoc({ name: "found.md", hash, source: "# Findable", board: board("ink") });
    // Renaming or moving the file on disk must not lose its ink.
    expect(findMdInkDocByHash(hash)?.id).toBe(saved.id);
    expect(findMdInkDocByHash(hashMarkdown("# Different"))).toBeNull();
  });

  it("gives two entries made in the same millisecond different ids", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const a = saveMdInkDoc({ name: "a.md", hash: "h-a", source: "# src", board: board("a") });
    const b = saveMdInkDoc({ name: "b.md", hash: "h-b", source: "# src", board: board("b") });
    expect(b.id).not.toBe(a.id);
    expect(listMdInkDocs()).toHaveLength(2);
  });

  it("refuses a new document once the library is full", () => {
    for (let i = 0; i < MD_INK_LIBRARY_LIMIT; i += 1) {
      saveMdInkDoc({ name: `n${i}.md`, hash: `hash-${i}`, source: "# src", board: board() });
    }
    expect(() =>
      saveMdInkDoc({ name: "extra.md", hash: "hash-extra", source: "# src", board: board() }),
    ).toThrow(MdInkLibraryFullError);
  });

  it("still updates a known document when the library is full", () => {
    for (let i = 0; i < MD_INK_LIBRARY_LIMIT; i += 1) {
      saveMdInkDoc({ name: `n${i}.md`, hash: `hash-${i}`, source: "# src", board: board() });
    }
    expect(() =>
      saveMdInkDoc({ name: "n0.md", hash: "hash-0", source: "# src", board: board("more") }),
    ).not.toThrow();
  });
});

describe("restoreMdInkDoc", () => {
  it("undoes a session's annotations without touching the rest", () => {
    const hash = hashMarkdown("# Kept");
    const original = saveMdInkDoc({ name: "kept.md", hash, source: "# Kept", board: board("original") });
    const baseline = getMdInkDoc(original.id) as MdInkDoc;
    saveMdInkDoc({ name: "other.md", hash: "other", source: "# src", board: board("other") });

    saveMdInkDoc({ name: "kept.md", hash, source: "# Kept", board: board("scribbles") });
    restoreMdInkDoc(baseline);

    expect(getMdInkDoc(original.id)).toEqual(baseline);
    expect(listMdInkDocs()).toHaveLength(2);
  });

  it("does not freshen the timestamp the way a save does", () => {
    const saved = saveMdInkDoc({ name: "a.md", hash: "h", source: "# src", board: board("a") });
    const baseline = getMdInkDoc(saved.id) as MdInkDoc;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    saveMdInkDoc({ name: "a.md", hash: "h", source: "# src", board: board("b") });
    restoreMdInkDoc(baseline);

    expect(getMdInkDoc(saved.id)?.updatedAt).toBe(baseline.updatedAt);
  });
});

describe("deleteMdInkDoc", () => {
  it("is how an annotation set that was never wanted goes away", () => {
    const saved = saveMdInkDoc({ name: "a.md", hash: "h", source: "# src", board: board() });
    deleteMdInkDoc(saved.id);
    expect(getMdInkDoc(saved.id)).toBeNull();
    expect(listMdInkDocs()).toHaveLength(0);
  });
});
