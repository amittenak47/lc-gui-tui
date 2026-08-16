import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardBlob } from "../canvas/BoardHandle";
import {
  deleteAnnotateDoc,
  findAnnotateDocByHash,
  findStaleAnnotateDoc,
  getAnnotateDoc,
  hashMarkdown,
  listAnnotateDocs,
  ANNOTATE_LIBRARY_LIMIT,
  AnnotateLibraryFullError,
  restoreAnnotateDoc,
  saveAnnotateDoc,
  type AnnotateDoc,
} from "./annotateStore";

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
  it("is stable for the same text and different for a change", async () => {
    expect(hashMarkdown("# Notes\n")).toBe(hashMarkdown("# Notes\n"));
    expect(hashMarkdown("# Notes\n")).not.toBe(hashMarkdown("# Notes!\n"));
  });

  it("separates texts of different length that would otherwise collide", async () => {
    expect(hashMarkdown("")).not.toBe(hashMarkdown("\0"));
  });
});

describe("saveAnnotateDoc", () => {
  it("updates the entry for markdown it has already seen", async () => {
    const hash = hashMarkdown("# Notes");
    const first = await saveAnnotateDoc({ name: "notes.md", hash, source: "# Notes", board: board("one") });
    const second = await saveAnnotateDoc({ name: "notes.md", hash, source: "# Notes", board: board("two") });

    // The same document annotated twice is one library entry, not two.
    expect(second.id).toBe(first.id);
    expect(listAnnotateDocs()).toHaveLength(1);
    expect((await getAnnotateDoc(first.id))?.board.elements).toEqual([{ id: "two" }]);
  });

  it("keeps annotations of different files apart", async () => {
    await saveAnnotateDoc({ name: "a.md", hash: hashMarkdown("# A"), source: "# src", board: board("a") });
    await saveAnnotateDoc({ name: "b.md", hash: hashMarkdown("# B"), source: "# src", board: board("b") });
    expect(listAnnotateDocs()).toHaveLength(2);
  });

  it("finds an annotation set by the markdown it was drawn over", async () => {
    const hash = hashMarkdown("# Findable");
    const saved = await saveAnnotateDoc({ name: "found.md", hash, source: "# Findable", board: board("ink") });
    // Renaming or moving the file on disk must not lose its ink.
    expect((await findAnnotateDocByHash(hash))?.id).toBe(saved.id);
    expect(await findAnnotateDocByHash(hashMarkdown("# Different"))).toBeNull();
  });

  it("gives two entries made in the same millisecond different ids", async () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const a = await saveAnnotateDoc({ name: "a.md", hash: "h-a", source: "# src", board: board("a") });
    const b = await saveAnnotateDoc({ name: "b.md", hash: "h-b", source: "# src", board: board("b") });
    expect(b.id).not.toBe(a.id);
    expect(listAnnotateDocs()).toHaveLength(2);
  });

  it("refuses a new document once the library is full", async () => {
    for (let i = 0; i < ANNOTATE_LIBRARY_LIMIT; i += 1) {
      await saveAnnotateDoc({ name: `n${i}.md`, hash: `hash-${i}`, source: "# src", board: board() });
    }
    await expect(
      saveAnnotateDoc({ name: "extra.md", hash: "hash-extra", source: "# src", board: board() }),
    ).rejects.toThrow(AnnotateLibraryFullError);
  });

  it("still updates a known document when the library is full", async () => {
    for (let i = 0; i < ANNOTATE_LIBRARY_LIMIT; i += 1) {
      await saveAnnotateDoc({ name: `n${i}.md`, hash: `hash-${i}`, source: "# src", board: board() });
    }
    await expect(
      saveAnnotateDoc({ name: "n0.md", hash: "hash-0", source: "# src", board: board("more") }),
    ).resolves.toBeTruthy();
  });

  it("stores code documents with docType code and their source text", async () => {
    const hash = hashMarkdown("def f():\n  return 1\n");
    const saved = await saveAnnotateDoc({
      name: "f.py",
      hash,
      docType: "code",
      source: "def f():\n  return 1\n",
      board: board("ink"),
    });
    const loaded = await getAnnotateDoc(saved.id);
    expect(loaded?.docType).toBe("code");
    expect(loaded?.source).toContain("def f()");
    expect((await findAnnotateDocByHash(hash))?.id).toBe(saved.id);
  });

  it("stores web snapshots with docType web and their HTML", async () => {
    const html = "<p>hi</p>";
    const hash = hashMarkdown(html);
    const saved = await saveAnnotateDoc({
      name: "https://www.google.com/",
      hash,
      docType: "web",
      source: html,
      board: board("ink"),
    });
    const loaded = await getAnnotateDoc(saved.id);
    expect(loaded?.docType).toBe("web");
    expect(loaded?.source).toBe(html);
    expect((await findAnnotateDocByHash(hash))?.id).toBe(saved.id);
  });
});

describe("restoreAnnotateDoc", () => {
  it("undoes a session's annotations without touching the rest", async () => {
    const hash = hashMarkdown("# Kept");
    const original = await saveAnnotateDoc({ name: "kept.md", hash, source: "# Kept", board: board("original") });
    const baseline = (await getAnnotateDoc(original.id)) as AnnotateDoc;
    await saveAnnotateDoc({ name: "other.md", hash: "other", source: "# src", board: board("other") });

    await saveAnnotateDoc({ name: "kept.md", hash, source: "# Kept", board: board("scribbles") });
    await restoreAnnotateDoc(baseline);

    expect(await getAnnotateDoc(original.id)).toEqual(baseline);
    expect(listAnnotateDocs()).toHaveLength(2);
  });

  it("does not freshen the timestamp the way a save does", async () => {
    const saved = await saveAnnotateDoc({ name: "a.md", hash: "h", source: "# src", board: board("a") });
    const baseline = (await getAnnotateDoc(saved.id)) as AnnotateDoc;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    await saveAnnotateDoc({ name: "a.md", hash: "h", source: "# src", board: board("b") });
    await restoreAnnotateDoc(baseline);

    expect((await getAnnotateDoc(saved.id))?.updatedAt).toBe(baseline.updatedAt);
  });
});

describe("deleteAnnotateDoc", () => {
  it("is how an annotation set that was never wanted goes away", async () => {
    const saved = await saveAnnotateDoc({ name: "a.md", hash: "h", source: "# src", board: board() });
    await deleteAnnotateDoc(saved.id);
    expect(await getAnnotateDoc(saved.id)).toBeNull();
    expect(listAnnotateDocs()).toHaveLength(0);
  });
});

describe("findStaleAnnotateDoc", () => {
  it("names the old set when a file has been edited since", async () => {
    await saveAnnotateDoc({ name: "notes.md", hash: "old-hash", source: "# v1", board: board() });
    // Same file on disk, edited — the ink belongs to text that has moved.
    const stale = findStaleAnnotateDoc("notes.md", "new-hash");
    expect(stale?.hash).toBe("old-hash");
  });

  it("stays quiet when the text is unchanged", async () => {
    await saveAnnotateDoc({ name: "notes.md", hash: "same", source: "# v1", board: board() });
    expect(findStaleAnnotateDoc("notes.md", "same")).toBeNull();
  });

  it("does not confuse a different file that happens to be open", async () => {
    await saveAnnotateDoc({ name: "notes.md", hash: "h1", source: "# a", board: board() });
    expect(findStaleAnnotateDoc("other.md", "h2")).toBeNull();
  });
});

describe("footnotes on an entry", () => {
  const mark = (start: number, end: number) => ({
    id: `fn-${start}`,
    kind: "search" as const,
    anchor: { kind: "text" as const, start, end },
    excerpt: "hash maps",
    createdAt: 1,
    query: "hash maps",
  });

  it("saves and reloads the marks a reading session left", async () => {
    const saved = await saveAnnotateDoc({
      name: "notes.md",
      hash: "h",
      source: "# src",
      board: board(),
      footnotes: [mark(0, 9)],
    });
    expect((await getAnnotateDoc(saved.id))?.footnotes).toEqual([mark(0, 9)]);
  });

  it("keeps the existing set when a caller does not track footnotes", async () => {
    // The autosave tick and the sidecar import both save without an opinion
    // about footnotes; neither should wipe the set the session built up.
    const saved = await saveAnnotateDoc({
      name: "notes.md",
      hash: "h",
      source: "# src",
      board: board(),
      footnotes: [mark(0, 9)],
    });
    await saveAnnotateDoc({ id: saved.id, name: "notes.md", hash: "h", source: "# src", board: board() });
    expect((await getAnnotateDoc(saved.id))?.footnotes).toHaveLength(1);
  });

  it("reads an entry written before footnotes existed as having none", async () => {
    const saved = await saveAnnotateDoc({ name: "old.md", hash: "h", source: "# src", board: board() });
    expect((await getAnnotateDoc(saved.id))?.footnotes).toEqual([]);
  });
});

describe("coach thread on an entry", () => {
  const turn = { id: "u1", role: "user", content: "what is this theorem?", at: 1 };

  it("saves and reloads the transcript", async () => {
    const saved = await saveAnnotateDoc({
      name: "notes.md",
      hash: "h",
      source: "# src",
      board: board(),
      agent: [turn],
    });
    expect((await getAnnotateDoc(saved.id))?.agent).toEqual([turn]);
  });

  it("keeps the existing thread when a caller does not track it", async () => {
    const saved = await saveAnnotateDoc({
      name: "notes.md",
      hash: "h",
      source: "# src",
      board: board(),
      agent: [turn],
    });
    await saveAnnotateDoc({
      id: saved.id,
      name: "notes.md",
      hash: "h",
      source: "# src",
      board: board(),
      footnotes: [],
    });
    expect((await getAnnotateDoc(saved.id))?.agent).toEqual([turn]);
  });

  it("reads an entry written before a thread existed as having none", async () => {
    const saved = await saveAnnotateDoc({ name: "old.md", hash: "h", source: "# src", board: board() });
    expect((await getAnnotateDoc(saved.id))?.agent).toEqual([]);
  });
});
