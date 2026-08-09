import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteScratchNotebook,
  getScratchNotebook,
  listScratchNotebooks,
  restoreScratchNotebook,
  saveScratchNotebook,
  ScratchpadLibraryFullError,
  SCRATCHPAD_LIBRARY_LIMIT,
  type ScratchBoardBlob,
  type ScratchNotebook,
} from "./scratchpadStore";

function board(mark = "a"): ScratchBoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
    ink: [],
  } as ScratchBoardBlob;
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
});

describe("saveScratchNotebook", () => {
  it("keeps one entry per id and moves it to the front", async () => {
    const first = await saveScratchNotebook({ board: board("a"), pageCount: 1, title: "One" });
    await saveScratchNotebook({ board: board("b"), pageCount: 1, title: "Two" });
    await saveScratchNotebook({ id: first.id, board: board("c"), pageCount: 2 });

    const list = listScratchNotebooks();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(first.id);
    expect(list[0].title).toBe("One");
    expect(list[0].pageCount).toBe(2);
  });

  it("gives two notebooks made in the same millisecond different ids", async () => {
    // Ids used to come from the clock alone, so a second notebook created
    // inside the same millisecond took the first one's id and overwrote it —
    // the library losing an entry where it should have gained one.
    vi.setSystemTime(new Date(1_700_000_000_000));
    const first = await saveScratchNotebook({ board: board("a"), pageCount: 1, title: "First" });
    const second = await saveScratchNotebook({ board: board("b"), pageCount: 1, title: "Second" });

    expect(second.id).not.toBe(first.id);
    expect(listScratchNotebooks()).toHaveLength(2);
    expect((await getScratchNotebook(first.id))?.title).toBe("First");
    vi.useRealTimers();
  });

  it("refuses a new notebook once the library is full", async () => {
    for (let i = 0; i < SCRATCHPAD_LIBRARY_LIMIT; i += 1) {
      await saveScratchNotebook({ board: board(`n${i}`), pageCount: 1, title: `N${i}` });
    }
    await expect(
      saveScratchNotebook({ board: board("x"), pageCount: 1 }),
    ).rejects.toThrow(ScratchpadLibraryFullError);
  });
});

describe("restoreScratchNotebook", () => {
  /**
   * The discard path, end to end: open a saved notebook, let the autosave
   * commit some writing over it, then put back what was there.
   */
  it("undoes what the autosave wrote over a saved notebook", async () => {
    const original = await saveScratchNotebook({
      board: board("original"),
      pageCount: 1,
      title: "Kept",
    });
    const baseline = (await getScratchNotebook(original.id)) as ScratchNotebook;

    await saveScratchNotebook({ id: original.id, board: board("scribbles"), pageCount: 3 });
    expect((await getScratchNotebook(original.id))?.pageCount).toBe(3);

    await restoreScratchNotebook(baseline);
    const after = await getScratchNotebook(original.id);
    expect(after).toEqual(baseline);
    expect(listScratchNotebooks()).toHaveLength(1);
  });

  it("does not freshen the timestamp the way a save does", async () => {
    const original = await saveScratchNotebook({ board: board("a"), pageCount: 1 });
    const baseline = (await getScratchNotebook(original.id)) as ScratchNotebook;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    await saveScratchNotebook({ id: original.id, board: board("b"), pageCount: 1 });
    expect((await getScratchNotebook(original.id))?.updatedAt).toBeGreaterThan(baseline.updatedAt);

    await restoreScratchNotebook(baseline);
    // A discarded session must not leave the notebook sitting at the top of the
    // library looking freshly worked on.
    expect((await getScratchNotebook(original.id))?.updatedAt).toBe(baseline.updatedAt);
    vi.useRealTimers();
  });

  it("restores past a full library, since the entry was already in it", async () => {
    const first = await saveScratchNotebook({ board: board("a"), pageCount: 1, title: "First" });
    const baseline = (await getScratchNotebook(first.id)) as ScratchNotebook;
    for (let i = 1; i < SCRATCHPAD_LIBRARY_LIMIT; i += 1) {
      await saveScratchNotebook({ board: board(`n${i}`), pageCount: 1, title: `N${i}` });
    }
    await saveScratchNotebook({ id: first.id, board: board("edited"), pageCount: 4 });

    await expect(restoreScratchNotebook(baseline)).resolves.toBeUndefined();
    expect(await getScratchNotebook(first.id)).toEqual(baseline);
    expect(listScratchNotebooks()).toHaveLength(SCRATCHPAD_LIBRARY_LIMIT);
  });
});

describe("deleteScratchNotebook", () => {
  it("is how a notebook that opened blank gets discarded", async () => {
    // No baseline to restore: the entry exists only because the autosave ran
    // mid-session, so discarding means it should never have been there.
    const created = await saveScratchNotebook({ board: board("autosaved"), pageCount: 1 });
    await deleteScratchNotebook(created.id);
    expect(await getScratchNotebook(created.id)).toBeNull();
    expect(listScratchNotebooks()).toHaveLength(0);
  });

  it("leaves the other notebooks alone", async () => {
    const keep = await saveScratchNotebook({ board: board("a"), pageCount: 1, title: "Keep" });
    const drop = await saveScratchNotebook({ board: board("b"), pageCount: 1, title: "Drop" });
    await deleteScratchNotebook(drop.id);
    expect(listScratchNotebooks().map((entry) => entry.id)).toEqual([keep.id]);
  });
});
