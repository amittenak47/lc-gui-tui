import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./bookSync", async (original) => ({
  ...(await original<typeof import("./bookSync")>()),
  syncBook: vi.fn(),
}));
vi.mock("./inkSync", async (original) => ({
  ...(await original<typeof import("./inkSync")>()),
  syncInkPages: vi.fn(async () => []),
  syncEdges: vi.fn(async () => {}),
}));

import type { FootnoteRequestDto, LcClient, PadSyncPingDto } from "../api/client";
import { syncBookPass } from "./bookSyncPass";
import { syncBook } from "./bookSync";
import { closeDbForTests, run, STORE_CONTENT } from "./idb";
import { saveAnnotateDoc, getAnnotateDoc, markAnnotateHubAck } from "./annotateStore";
import { saveWhiteboardNotebook } from "./whiteboardStore";
import { getContent } from "./contentStore";
import { mutateLocalBook, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests, withBookWrite } from "./bookCoordinator";
import { saveHubAutosyncPref } from "./hubAutoSyncPref";
import { applyPadSyncPing, resetPadSyncForTests } from "./padSync";
import { resetCameraBusyForTests } from "./cameraBusy";
import { enqueueFootnoteRequest, registerOpenAnnotateFootnotes } from "./footnoteRequests";
import type { DocFootnote } from "./docFootnotes";

const board = { v: 1 as const, elements: [] as { id: string }[], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const tails = new Map<string, Promise<unknown>>();
let lockWaiters = 0;
let ping: PadSyncPingDto;
let api: LcClient;

function deferred() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

function mark(pending = "fr-1"): DocFootnote {
  return {
    id: "fn-1",
    kind: "ai",
    anchor: { kind: "text", start: 1, end: 6 },
    excerpt: "lemma",
    createdAt: 1,
    pending,
  };
}

function answer(id = "fr-1", docId = "notes") {
  return { id, doc_id: docId, result: { notes: ["from GrokBot"] } };
}

beforeEach(async () => {
  await closeDbForTests();
  resetLocalBookStoreForTests();
  resetBookCoordinatorForTests();
  resetPadSyncForTests();
  resetCameraBusyForTests();
  tails.clear();
  lockWaiters = 0;
  vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return storage.size; },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: (name: string, work: () => Promise<unknown>) => {
        const previous = tails.get(name) ?? Promise.resolve();
        if (tails.has(name)) lockWaiters += 1;
        const result = previous.catch(() => {}).then(work);
        tails.set(name, result);
        return result;
      },
    },
  });
  ping = {
    features: ["atomic_book_sync_v1"],
    books: [],
    now: 1,
    whiteboard: [],
    annotate: [],
    problem: [],
    gone: [],
    snapshots: [],
    ink: [],
    edges: [],
    gone_edges: [],
  };
  api = {
    pingPadSync: vi.fn(async () => ping),
    postFootnoteRequest: vi.fn(async () => {}),
    ackFootnoteRequest: vi.fn(async () => {}),
    listSnapshotCopies: vi.fn(async () => []),
    putSnapshotCopy: vi.fn(async () => ({ stored: true })),
    footnoteResults: vi.fn(async () => []),
  } as unknown as LcClient;
  vi.mocked(syncBook).mockImplementation(async (_client, kind, id) => ({ kind, id, status: "synced", committed: true }));
});

afterEach(async () => {
  await closeDbForTests();
  resetLocalBookStoreForTests();
  vi.unstubAllGlobals();
});

async function saveNotes(id = "notes", source = "original") {
  return saveAnnotateDoc({
    id,
    name: "Notes.md",
    hash: "hash-1",
    source,
    board,
    footnotes: [mark()],
    agent: [{ id: "t1", role: "user", text: "keep" }],
  });
}

async function markClean(id: string) {
  const doc = await getAnnotateDoc(id);
  if (!doc) throw new Error("missing document");
  await markAnnotateHubAck(id, doc.updatedAt);
  await mutateLocalBook({ kind: "annotate", id }, { authored: false }, (ctx) => {
    ctx.setState({ ...ctx.state, bootstrap: false, syncedChangeSeq: ctx.state.changeSeq });
  });
}

it("saves a ping answer into a clean book before that pass chooses what to upload", async () => {
  await saveNotes();
  await markClean("notes");
  enqueueFootnoteRequest({ id: "fr-upload", doc_id: "notes" } as FootnoteRequestDto);
  const upload = deferred();
  vi.mocked(api.postFootnoteRequest).mockImplementation(() => upload.opened);
  ping.footnote_results = [answer()];
  try {
    const result = await syncBookPass(api, { ping });
    expect(vi.mocked(syncBook).mock.calls.map((call) => call[2])).toContain("notes");
    const stored = await getAnnotateDoc("notes");
    expect(stored?.footnotes?.[0]?.notes?.map((note) => note.text)).toEqual(["from GrokBot"]);
    expect(stored?.source).toBe("original");
    expect(result.books.map((book) => book.id)).toContain("notes");
  } finally {
    upload.release();
  }
});

it("keeps a competing edit when the answer is written", async () => {
  await saveNotes();
  const gate = deferred();
  const started = deferred();
  const holder = withBookWrite("annotate", "notes", async () => {
    started.release();
    await gate.opened;
    const current = await getContent<Record<string, unknown>>("notes");
    await run(STORE_CONTENT, "readwrite", (store) => store.put({
      ...current,
      source: "rewritten",
      agent: [{ id: "t2", role: "user", text: "newer" }],
      board: { ...board, elements: [{ id: "kept" }] },
    }, "notes"));
  });
  await started.opened;
  const applying = applyPadSyncAnswer();
  await vi.waitFor(() => expect(lockWaiters).toBeGreaterThan(0));
  gate.release();
  await holder;
  await applying;
  const stored = await getAnnotateDoc("notes");
  expect(stored?.source).toBe("rewritten");
  expect(stored?.agent).toEqual([{ id: "t2", role: "user", text: "newer" }]);
  expect((stored?.board as { elements?: { id: string }[] }).elements).toEqual([{ id: "kept" }]);
  expect(stored?.footnotes?.[0]?.notes?.map((note) => note.text)).toEqual(["from GrokBot"]);
});

function applyPadSyncAnswer() {
  return import("./footnoteRequests").then((mod) => mod.applyFootnotePing(api, { footnote_results: [answer()] }));
}

it("leaves a failed answer unacked and still syncs the other book", async () => {
  await saveNotes();
  await saveWhiteboardNotebook({ id: "other", title: "Other", board, pageCount: 1 });
  const unregister = registerOpenAnnotateFootnotes({
    docId: () => "notes",
    write: async () => "failed",
  });
  ping.footnote_results = [answer()];
  try {
    const result = await syncBookPass(api, { ping });
    expect(result.notices).toContainEqual(expect.objectContaining({
      kind: "footnote",
      book: { kind: "annotate", id: "notes" },
    }));
    expect(vi.mocked(syncBook).mock.calls.map((call) => call[2])).toContain("other");
    expect(api.ackFootnoteRequest).not.toHaveBeenCalled();
    const stored = await getAnnotateDoc("notes");
    expect(stored?.footnotes?.[0]?.pending).toBe("fr-1");
  } finally {
    unregister();
  }
});

it("saves a polled answer without uploading, then a later sync sends the book", async () => {
  saveHubAutosyncPref("off");
  await saveNotes();
  await markClean("notes");
  enqueueFootnoteRequest({ id: "fr-upload", doc_id: "notes" } as FootnoteRequestDto);
  vi.mocked(api.footnoteResults).mockResolvedValue([answer()]);
  vi.mocked(api.postFootnoteRequest).mockResolvedValue(undefined);
  await import("./footnoteRequests").then((mod) => mod.pollFootnoteInbox(api));
  expect(api.pingPadSync).not.toHaveBeenCalled();
  expect(syncBook).not.toHaveBeenCalled();
  const stored = await getAnnotateDoc("notes");
  expect(stored?.footnotes?.[0]?.notes?.map((note) => note.text)).toEqual(["from GrokBot"]);
  ping.footnote_results = [];
  await syncBookPass(api, { ping });
  expect(vi.mocked(syncBook).mock.calls.map((call) => call[2])).toContain("notes");
});

it("does not start an answer after cancel and does not overwrite a later edit", async () => {
  await saveNotes();
  const controller = new AbortController();
  controller.abort();
  const gate = deferred();
  const started = deferred();
  const holder = withBookWrite("annotate", "notes", async () => {
    started.release();
    await gate.opened;
    const current = await getContent<Record<string, unknown>>("notes");
    await run(STORE_CONTENT, "readwrite", (store) => store.put({ ...current, source: "rewritten" }, "notes"));
  });
  await started.opened;
  const { applyFootnoteAnswers } = await import("./footnoteRequests");
  const applied = applyFootnoteAnswers([answer()], { signal: controller.signal });
  gate.release();
  await holder;
  const outcome = await applied;
  expect(outcome.saved).toEqual([]);
  expect(outcome.failed).toEqual([]);
  const stored = await getAnnotateDoc("notes");
  expect(stored?.source).toBe("rewritten");
  expect(stored?.footnotes?.[0]?.pending).toBe("fr-1");
});

it("finishes an answer already writing when the pass is cancelled, and skips the next one", async () => {
  await saveNotes("notes");
  await saveNotes("other");
  const controller = new AbortController();
  const { applyFootnoteAnswers } = await import("./footnoteRequests");
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const unregister = registerOpenAnnotateFootnotes({
    docId: () => "notes",
    write: async (_docId, mutate) => {
      controller.abort();
      await firstWrite;
      const doc = await getAnnotateDoc("notes");
      if (!doc) return "failed";
      await saveAnnotateDoc({
        id: doc.id,
        name: doc.name,
        hash: doc.hash,
        source: doc.source,
        board: doc.board,
        footnotes: mutate(doc.footnotes ?? []),
        agent: Array.isArray(doc.agent) ? doc.agent : undefined,
      });
      return "saved";
    },
  });
  try {
    const pending = applyFootnoteAnswers([answer("fr-1", "notes"), answer("fr-1", "other")], { signal: controller.signal });
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    releaseFirst();
    const outcome = await pending;
    expect(outcome.saved).toEqual(["fr-1"]);
    expect(outcome.failed).toEqual([]);
    expect((await getAnnotateDoc("notes"))?.footnotes?.[0]?.notes?.map((note) => note.text)).toEqual(["from GrokBot"]);
    expect((await getAnnotateDoc("other"))?.footnotes?.[0]?.pending).toBe("fr-1");
  } finally {
    unregister();
  }
});

it("saves a legacy ping answer before that ping can tombstone the document", async () => {
  saveHubAutosyncPref("on");
  await saveNotes();
  await markClean("notes");
  const gate = deferred();
  const started = deferred();
  const holder = withBookWrite("annotate", "notes", async () => {
    started.release();
    await gate.opened;
  });
  ping.gone = [{ kind: "annotate", id: "notes", seq: 1, gone_at: 1 }];
  ping.footnote_results = [answer()];
  ping.now = 9;
  const running = applyPadSyncPing(api);
  await started.opened;
  gate.release();
  await holder;
  await running;
  const stored = await getAnnotateDoc("notes");
  expect(stored?.footnotes?.[0]?.notes?.map((note) => note.text)).toEqual(["from GrokBot"]);
});
