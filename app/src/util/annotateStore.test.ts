import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardBlob } from "../canvas/BoardHandle";
import {
  deleteAnnotateDoc,
  findAnnotateDocByHash,
  findStaleAnnotateDoc,
  annotateDocLabel,
  annotateKeyMigrationPlan,
  freshAnnotateId,
  setAnnotateDocLabel,
  listAnnotateDocsByHash,
  getAnnotateDoc,
  hashMarkdown,
  listAnnotateDocs,
  listAnnotateTrash,
  ANNOTATE_LIBRARY_LIMIT,
  ANNOTATE_TRASH_TTL_MS,
  AnnotateLibraryFullError,
  restoreAnnotateDoc,
  restoreAnnotateFromTrash,
  saveAnnotateDoc,
  uniqueAnnotateName,
  setAnnotateDocLocked,
  sweepAnnotateTrash,
  trashAnnotateDoc,
  type AnnotateDoc,
} from "./annotateStore";

const deleteDocBytes = vi.fn(async (_hash?: string) => {});
vi.mock("./docBytes", () => ({
  deleteDocBytes: (hash: string) => deleteDocBytes(hash),
}));

function board(mark = "a"): BoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
    ink: [],
  } as BoardBlob;
}

beforeEach(() => {
  deleteDocBytes.mockClear();
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
  it("updates the entry it is given the id of", async () => {
    const hash = hashMarkdown("# Notes");
    const first = await saveAnnotateDoc({ name: "notes.md", hash, source: "# Notes", board: board("one") });
    const second = await saveAnnotateDoc({
      id: first.id,
      name: "notes.md",
      hash,
      source: "# Notes",
      board: board("two"),
    });

    // One session, one entry — the second save is the same set, moved on.
    expect(second.id).toBe(first.id);
    expect(listAnnotateDocs()).toHaveLength(1);
    expect((await getAnnotateDoc(first.id))?.board.elements).toEqual([{ id: "two" }]);
  });

  it("starts a second set on one file rather than overwriting the first", async () => {
    // The whole point of keying on id: one PDF, two independent sets of marks.
    const hash = hashMarkdown("# Shared");
    const first = await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("first") });
    const second = await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("second") });

    expect(second.id).not.toBe(first.id);
    expect(listAnnotateDocs()).toHaveLength(2);
    // Neither set has touched the other.
    expect((await getAnnotateDoc(first.id))?.board.elements).toEqual([{ id: "first" }]);
    expect((await getAnnotateDoc(second.id))?.board.elements).toEqual([{ id: "second" }]);
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
    const ids: string[] = [];
    for (let i = 0; i < ANNOTATE_LIBRARY_LIMIT; i += 1) {
      const saved = await saveAnnotateDoc({
        name: `n${i}.md`,
        hash: `hash-${i}`,
        source: "# src",
        board: board(),
      });
      ids.push(saved.id);
    }
    await expect(
      saveAnnotateDoc({
        id: ids[0],
        name: "n0.md",
        hash: "hash-0",
        source: "# src",
        board: board("more"),
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a second set on a known file when the library is full", async () => {
    // A fork is a new row, so it is subject to the cap like any other.
    for (let i = 0; i < ANNOTATE_LIBRARY_LIMIT; i += 1) {
      await saveAnnotateDoc({ name: `n${i}.md`, hash: `hash-${i}`, source: "# src", board: board() });
    }
    await expect(
      saveAnnotateDoc({ name: "n0.md", hash: "hash-0", source: "# src", board: board("fork") }),
    ).rejects.toThrow(AnnotateLibraryFullError);
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

    await saveAnnotateDoc({
      id: original.id,
      name: "kept.md",
      hash,
      source: "# Kept",
      board: board("scribbles"),
    });
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

  it("refuses to delete a locked set, and a later save keeps the lock", async () => {
    const saved = await saveAnnotateDoc({ name: "a.md", hash: "h", source: "# src", board: board() });
    setAnnotateDocLocked(saved.id, true);
    await deleteAnnotateDoc(saved.id);
    expect(listAnnotateDocs()).toHaveLength(1);
    await saveAnnotateDoc({
      id: saved.id,
      name: "a.md",
      hash: "h",
      source: "# src",
      board: board("more"),
    });
    expect(listAnnotateDocs()[0]?.locked).toBe(true);
  });
});

describe("listAnnotateDocsByHash", () => {
  it("returns every set on those bytes, newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const hash = hashMarkdown("# Shared");
    const first = await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("one") });
    vi.setSystemTime(new Date(1_700_000_060_000));
    const second = await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("two") });
    await saveAnnotateDoc({ name: "other.pdf", hash: "elsewhere", source: "", board: board() });

    expect(listAnnotateDocsByHash(hash).map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(listAnnotateDocsByHash("nothing-here")).toEqual([]);
  });

  it("hands the newest set to the single-result lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const hash = hashMarkdown("# Shared");
    await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("one") });
    vi.setSystemTime(new Date(1_700_000_060_000));
    const second = await saveAnnotateDoc({ name: "dp.pdf", hash, source: "", board: board("two") });

    expect((await findAnnotateDocByHash(hash))?.id).toBe(second.id);
  });
});

describe("owned notes", () => {
  it("remembers that a note was written here, not opened", async () => {
    const saved = await saveAnnotateDoc({
      name: "ideas.md",
      hash: hashMarkdown("# Ideas\n\n"),
      owned: true,
      source: "# Ideas\n\n",
      board: board(),
    });
    expect(listAnnotateDocs()[0]!.owned).toBe(true);
    expect((await getAnnotateDoc(saved.id))?.owned).toBe(true);
  });

  it("treats anything opened from a file as imported", async () => {
    await saveAnnotateDoc({ name: "dp.pdf", hash: "h", source: "", board: board() });
    // Absent rather than false — an old row that predates New file has to read
    // as imported too, and that is what a missing value means.
    expect(listAnnotateDocs()[0]!.owned).toBeUndefined();
  });

  it("keeps ownership across a save that does not mention it", async () => {
    // Autosave passes no `owned`. Dropping it would turn a note the reader can
    // edit into one they cannot, three seconds after they started.
    const saved = await saveAnnotateDoc({
      name: "ideas.md",
      hash: "h1",
      owned: true,
      source: "# Ideas",
      board: board(),
    });
    await saveAnnotateDoc({ id: saved.id, name: "ideas.md", hash: "h2", source: "# Edited", board: board() });
    expect(listAnnotateDocs()[0]!.owned).toBe(true);
  });

  it("keeps one id while the text — and so the hash — moves", async () => {
    // The reason ink stopped being hash-keyed: editing a note renames every
    // byte of it, and the strokes over it have to survive that.
    const first = hashMarkdown("# One");
    const saved = await saveAnnotateDoc({
      name: "n.md",
      hash: first,
      owned: true,
      source: "# One",
      board: board("ink"),
    });
    const second = hashMarkdown("# Two");
    const after = await saveAnnotateDoc({
      id: saved.id,
      name: "n.md",
      hash: second,
      owned: true,
      source: "# Two",
      board: board("ink"),
    });
    expect(after.id).toBe(saved.id);
    expect(after.hash).toBe(second);
    expect(listAnnotateDocs()).toHaveLength(1);
    expect(listAnnotateDocsByHash(first)).toEqual([]);
    expect(listAnnotateDocsByHash(second).map((entry) => entry.id)).toEqual([saved.id]);
  });
});

describe("annotateDocLabel", () => {
  const meta = (over: Partial<Parameters<typeof annotateDocLabel>[0]> = {}) => ({
    id: "mdink-1",
    name: "dp.pdf",
    hash: "h",
    docType: "pdf" as const,
    updatedAt: new Date("2026-08-18T10:00:00Z").getTime(),
    ...over,
  });

  it("uses the set's own name once it has been given one", () => {
    expect(annotateDocLabel(meta({ label: "Second pass" }))).toBe("Second pass");
  });

  it("falls back to the file name and a date, not a counter", () => {
    // "dp.pdf (2)" says only that it was not the first. A date says which
    // sitting it was, which is the thing the reader actually remembers.
    const label = annotateDocLabel(meta());
    expect(label.startsWith("dp.pdf — ")).toBe(true);
    expect(label).not.toBe("dp.pdf");
  });

  it("ignores a label that is only whitespace", () => {
    expect(annotateDocLabel(meta({ label: "   " })).startsWith("dp.pdf — ")).toBe(true);
  });

  it("falls back to the bare name when the timestamp is unusable", () => {
    expect(annotateDocLabel(meta({ updatedAt: Number.NaN }))).toBe("dp.pdf");
  });
});

describe("setAnnotateDocLabel", () => {
  it("renames the set without freshening it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const saved = await saveAnnotateDoc({ name: "dp.pdf", hash: "h", source: "", board: board() });

    vi.setSystemTime(new Date(1_700_000_900_000));
    setAnnotateDocLabel(saved.id, "Second pass");

    const meta = listAnnotateDocs()[0]!;
    expect(meta.label).toBe("Second pass");
    // Renaming is not annotating — it must not push the set up Recent.
    expect(meta.updatedAt).toBe(1_700_000_000_000);
  });

  it("clears the label when given an empty name", async () => {
    const saved = await saveAnnotateDoc({
      name: "dp.pdf",
      hash: "h",
      label: "Second pass",
      source: "",
      board: board(),
    });
    setAnnotateDocLabel(saved.id, "  ");
    expect(listAnnotateDocs()[0]!.label).toBeUndefined();
  });

  it("keeps a label across a save that does not mention one", async () => {
    // Autosave passes no label. Dropping it there would rename the set back
    // every three seconds.
    const saved = await saveAnnotateDoc({
      name: "dp.pdf",
      hash: "h",
      label: "Second pass",
      source: "",
      board: board(),
    });
    await saveAnnotateDoc({ id: saved.id, name: "dp.pdf", hash: "h", source: "", board: board("x") });
    expect(listAnnotateDocs()[0]!.label).toBe("Second pass");
  });

  it("does nothing for an id that is not in the library", () => {
    expect(setAnnotateDocLabel("mdink-nope", "x")).toBe(false);
  });
});

describe("freshAnnotateId", () => {
  it("hands out an id without reserving a library slot", async () => {
    const id = freshAnnotateId();
    expect(id).toMatch(/^mdink-/);
    // Nothing is written until a save uses it.
    expect(listAnnotateDocs()).toHaveLength(0);
    expect(await getAnnotateDoc(id)).toBeNull();
  });

  it("does not collide with an entry already in the library", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const saved = await saveAnnotateDoc({ name: "a.md", hash: "h", source: "", board: board() });
    expect(freshAnnotateId()).not.toBe(saved.id);
  });
});

describe("annotateKeyMigrationPlan", () => {
  const row = (id: string, hash: string, updatedAt: number) =>
    ({ id, name: `${id}.md`, hash, docType: "markdown", updatedAt }) as const;

  it("moves each set's ink from its file hash onto its own id", () => {
    expect(
      annotateKeyMigrationPlan([row("mdink-1", "bin-abc", 10), row("mdink-2", "md-xyz", 20)]),
    ).toEqual([
      { from: "md-xyz", to: "mdink-2" },
      { from: "bin-abc", to: "mdink-1" },
    ]);
  });

  it("gives shared-hash ink to the most recently updated set", () => {
    // Two sets on one file cannot both own one pile of hash-keyed strokes, and
    // there is no way to tell whose they were — so the live set takes them and
    // the older one starts clean rather than the ink being copied to both.
    const plan = annotateKeyMigrationPlan([
      row("mdink-old", "bin-abc", 10),
      row("mdink-new", "bin-abc", 99),
    ]);
    expect(plan).toEqual([{ from: "bin-abc", to: "mdink-new" }]);
  });

  it("skips a row whose hash is already its id", () => {
    expect(annotateKeyMigrationPlan([row("same", "same", 1)])).toEqual([]);
  });

  it("plans nothing for an empty library", () => {
    expect(annotateKeyMigrationPlan([])).toEqual([]);
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

describe("annotate trash", () => {
  it("hides the pad from live and from hash forks", async () => {
    const hash = "pdf-shared";
    const first = await saveAnnotateDoc({
      name: "dp.pdf",
      hash,
      docType: "pdf",
      source: "",
      board: board("one"),
    });
    const second = await saveAnnotateDoc({
      name: "dp.pdf",
      hash,
      docType: "pdf",
      source: "",
      board: board("two"),
    });
    await trashAnnotateDoc(first.id);
    expect(listAnnotateDocs().map((row) => row.id)).toEqual([second.id]);
    expect(listAnnotateDocsByHash(hash).map((row) => row.id)).toEqual([second.id]);
    expect(listAnnotateTrash().map((row) => row.id)).toEqual([first.id]);
    await restoreAnnotateFromTrash(first.id);
    expect(listAnnotateDocsByHash(hash)).toHaveLength(2);
  });

  it("GCs the blob only after the last id that shares the hash is gone", async () => {
    const hash = "pdf-shared";
    const first = await saveAnnotateDoc({
      name: "dp.pdf",
      hash,
      docType: "pdf",
      source: "",
      board: board("one"),
    });
    const second = await saveAnnotateDoc({
      name: "dp.pdf",
      hash,
      docType: "pdf",
      source: "",
      board: board("two"),
    });
    await deleteAnnotateDoc(first.id);
    expect(deleteDocBytes).not.toHaveBeenCalled();
    await deleteAnnotateDoc(second.id);
    expect(deleteDocBytes).toHaveBeenCalledWith(hash);
  });

  it("sweeps only after ACK and TTL", async () => {
    const saved = await saveAnnotateDoc({ name: "a.md", hash: "h", source: "#", board: board() });
    await trashAnnotateDoc(saved.id, 1);
    const { markAnnotateDeleteAcked } = await import("./annotateStore");
    expect(await sweepAnnotateTrash(1 + ANNOTATE_TRASH_TTL_MS)).toEqual([]);
    markAnnotateDeleteAcked(saved.id, true);
    expect(await sweepAnnotateTrash(1 + ANNOTATE_TRASH_TTL_MS)).toEqual([saved.id]);
    expect(listAnnotateTrash()).toHaveLength(0);
  });
});

describe("uniqueAnnotateName", () => {
  const board = (id: string) =>
    ({ v: 1, elements: [{ id }], appState: {} }) as unknown as BoardBlob;

  it("leaves a name nothing is using", () => {
    expect(uniqueAnnotateName("Untitled.md")).toBe("Untitled.md");
  });

  it("numbers a repeat, before the extension", async () => {
    await saveAnnotateDoc({ name: "Untitled.md", hash: "h1", source: "", board: board("a") });
    expect(uniqueAnnotateName("Untitled.md")).toBe("Untitled (1).md");
  });

  it("keeps counting past the first collision", async () => {
    await saveAnnotateDoc({ name: "Untitled.md", hash: "h1", source: "", board: board("a") });
    await saveAnnotateDoc({
      name: "Untitled (1).md",
      hash: "h2",
      source: "",
      board: board("b"),
    });
    expect(uniqueAnnotateName("Untitled.md")).toBe("Untitled (2).md");
  });

  it("ignores case, the way a file manager would", async () => {
    await saveAnnotateDoc({ name: "Notes.md", hash: "h1", source: "", board: board("a") });
    expect(uniqueAnnotateName("notes.md")).toBe("notes (1).md");
  });

  it("lets a trashed name be taken again", async () => {
    const doc = await saveAnnotateDoc({
      name: "Untitled.md",
      hash: "h1",
      source: "",
      board: board("a"),
    });
    deleteAnnotateDoc(doc.id);
    expect(uniqueAnnotateName("Untitled.md")).toBe("Untitled.md");
  });
});
