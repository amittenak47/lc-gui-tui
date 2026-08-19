import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteWhiteboardNotebook,
  getWhiteboardNotebook,
  listWhiteboardNotebooks,
  listWhiteboardTrash,
  restoreWhiteboardFromTrash,
  restoreWhiteboardNotebook,
  saveWhiteboardNotebook,
  setWhiteboardNotebookLocked,
  sweepWhiteboardTrash,
  trashWhiteboardNotebook,
  WhiteboardLibraryFullError,
  WHITEBOARD_LIBRARY_LIMIT,
  PAD_TRASH_TTL_MS,
  type WhiteboardBoardBlob,
  type WhiteboardNotebook,
} from "./whiteboardStore";

function board(mark = "a"): WhiteboardBoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
    ink: [],
  } as WhiteboardBoardBlob;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveWhiteboardNotebook", () => {
  it("keeps one entry per id and moves it to the front", async () => {
    const first = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "One" });
    await saveWhiteboardNotebook({ board: board("b"), pageCount: 1, title: "Two" });
    await saveWhiteboardNotebook({ id: first.id, board: board("c"), pageCount: 2 });

    const list = listWhiteboardNotebooks();
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
    const first = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "First" });
    const second = await saveWhiteboardNotebook({ board: board("b"), pageCount: 1, title: "Second" });

    expect(second.id).not.toBe(first.id);
    expect(listWhiteboardNotebooks()).toHaveLength(2);
    expect((await getWhiteboardNotebook(first.id))?.title).toBe("First");
    vi.useRealTimers();
  });

  it("refuses a new notebook once the library is full", async () => {
    for (let i = 0; i < WHITEBOARD_LIBRARY_LIMIT; i += 1) {
      await saveWhiteboardNotebook({ board: board(`n${i}`), pageCount: 1, title: `N${i}` });
    }
    await expect(
      saveWhiteboardNotebook({ board: board("x"), pageCount: 1 }),
    ).rejects.toThrow(WhiteboardLibraryFullError);
  });
});

describe("restoreWhiteboardNotebook", () => {
  /**
   * The discard path, end to end: open a saved notebook, let the autosave
   * commit some writing over it, then put back what was there.
   */
  it("undoes what the autosave wrote over a saved notebook", async () => {
    const original = await saveWhiteboardNotebook({
      board: board("original"),
      pageCount: 1,
      title: "Kept",
    });
    const baseline = (await getWhiteboardNotebook(original.id)) as WhiteboardNotebook;

    await saveWhiteboardNotebook({ id: original.id, board: board("scribbles"), pageCount: 3 });
    expect((await getWhiteboardNotebook(original.id))?.pageCount).toBe(3);

    await restoreWhiteboardNotebook(baseline);
    const after = await getWhiteboardNotebook(original.id);
    expect(after).toEqual(baseline);
    expect(listWhiteboardNotebooks()).toHaveLength(1);
  });

  it("does not freshen the timestamp the way a save does", async () => {
    const original = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1 });
    const baseline = (await getWhiteboardNotebook(original.id)) as WhiteboardNotebook;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    await saveWhiteboardNotebook({ id: original.id, board: board("b"), pageCount: 1 });
    expect((await getWhiteboardNotebook(original.id))?.updatedAt).toBeGreaterThan(baseline.updatedAt);

    await restoreWhiteboardNotebook(baseline);
    // A discarded session must not leave the notebook sitting at the top of the
    // library looking freshly worked on.
    expect((await getWhiteboardNotebook(original.id))?.updatedAt).toBe(baseline.updatedAt);
    vi.useRealTimers();
  });

  it("restores past a full library, since the entry was already in it", async () => {
    const first = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "First" });
    const baseline = (await getWhiteboardNotebook(first.id)) as WhiteboardNotebook;
    for (let i = 1; i < WHITEBOARD_LIBRARY_LIMIT; i += 1) {
      await saveWhiteboardNotebook({ board: board(`n${i}`), pageCount: 1, title: `N${i}` });
    }
    await saveWhiteboardNotebook({ id: first.id, board: board("edited"), pageCount: 4 });

    await expect(restoreWhiteboardNotebook(baseline)).resolves.toBeUndefined();
    expect(await getWhiteboardNotebook(first.id)).toEqual(baseline);
    expect(listWhiteboardNotebooks()).toHaveLength(WHITEBOARD_LIBRARY_LIMIT);
  });
});

describe("deleteWhiteboardNotebook", () => {
  it("is how a notebook that opened blank gets discarded", async () => {
    // No baseline to restore: the entry exists only because the autosave ran
    // mid-session, so discarding means it should never have been there.
    const created = await saveWhiteboardNotebook({ board: board("autosaved"), pageCount: 1 });
    await deleteWhiteboardNotebook(created.id);
    expect(await getWhiteboardNotebook(created.id)).toBeNull();
    expect(listWhiteboardNotebooks()).toHaveLength(0);
  });

  it("leaves the other notebooks alone", async () => {
    const keep = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "Keep" });
    const drop = await saveWhiteboardNotebook({ board: board("b"), pageCount: 1, title: "Drop" });
    await deleteWhiteboardNotebook(drop.id);
    expect(listWhiteboardNotebooks().map((entry) => entry.id)).toEqual([keep.id]);
  });

  it("refuses to delete a locked notebook, and a later save keeps the lock", async () => {
    const row = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "Keep" });
    setWhiteboardNotebookLocked(row.id, true);
    await deleteWhiteboardNotebook(row.id);
    expect(listWhiteboardNotebooks()).toHaveLength(1);
    await saveWhiteboardNotebook({ id: row.id, board: board("b"), pageCount: 1 });
    expect(listWhiteboardNotebooks()[0]?.locked).toBe(true);
  });
});

describe("whiteboard trash", () => {
  it("hides the pad from live and restores it", async () => {
    const row = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "N" });
    const seq = await trashWhiteboardNotebook(row.id);
    expect(seq).toBe(1);
    expect(listWhiteboardNotebooks()).toHaveLength(0);
    expect(listWhiteboardTrash()).toHaveLength(1);
    const back = await restoreWhiteboardFromTrash(row.id);
    expect(back?.id).toBe(row.id);
    expect(listWhiteboardNotebooks()).toHaveLength(1);
    expect(listWhiteboardTrash()).toHaveLength(0);
  });

  it("is a no-op when locked", async () => {
    const row = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "Keep" });
    setWhiteboardNotebookLocked(row.id, true);
    expect(await trashWhiteboardNotebook(row.id)).toBeNull();
    expect(listWhiteboardNotebooks()).toHaveLength(1);
    expect(listWhiteboardTrash()).toHaveLength(0);
  });

  it("refuses restore when live library is full", async () => {
    const first = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "First" });
    await trashWhiteboardNotebook(first.id);
    for (let i = 0; i < WHITEBOARD_LIBRARY_LIMIT; i += 1) {
      await saveWhiteboardNotebook({ board: board("x"), pageCount: 1, title: `N${i}` });
    }
    await expect(restoreWhiteboardFromTrash(first.id)).rejects.toBeInstanceOf(
      WhiteboardLibraryFullError,
    );
    expect(listWhiteboardTrash().map((row) => row.id)).toContain(first.id);
  });

  it("sweeps only after ACK and TTL", async () => {
    const row = await saveWhiteboardNotebook({ board: board("a"), pageCount: 1, title: "N" });
    await trashWhiteboardNotebook(row.id, 1);
    expect(await sweepWhiteboardTrash(1 + PAD_TRASH_TTL_MS)).toEqual([]);
    expect(listWhiteboardTrash()).toHaveLength(1);
    const { markWhiteboardDeleteAcked } = await import("./whiteboardStore");
    markWhiteboardDeleteAcked(row.id, true);
    expect(await sweepWhiteboardTrash(1 + PAD_TRASH_TTL_MS)).toEqual([row.id]);
    expect(listWhiteboardTrash()).toHaveLength(0);
    expect(await getWhiteboardNotebook(row.id)).toBeNull();
  });
});
