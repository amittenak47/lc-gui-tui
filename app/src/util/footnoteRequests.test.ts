import { IDBFactory } from "fake-indexeddb";
import { readFootnoteOutbox } from "./footnoteOutbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FootnoteRequestDto, LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";
import { applyFootnotePing, applyFootnoteResult, registerOpenAnnotateFootnotes } from "./footnoteRequests";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

const debugLog = vi.hoisted(() => vi.fn());
vi.mock("./debugLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./debugLog")>()),
  debugLog,
}));

const store = vi.hoisted(() => ({
  doc: null as null | { id: string; name: string; footnotes: unknown[] },
  saves: 0,
  saved: [] as unknown[][],
}));

vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async () => store.doc,
  saveAnnotateDoc: async (doc: { id?: string; name?: string; footnotes?: unknown[] }) => {
    store.saves += 1;
    const footnotes = [...(doc.footnotes ?? [])];
    store.saved.push(footnotes);
    store.doc = {
      id: doc.id ?? store.doc?.id ?? "doc",
      name: doc.name ?? store.doc?.name ?? "Doc",
      footnotes,
    };
  },
  mutateAnnotateFootnotes: async (
    id: string,
    mutate: (footnotes: { id?: string }[]) => { id?: string }[],
  ) => {
    if (!store.doc || store.doc.id !== id) return "gone";
    const current = [...(store.doc.footnotes ?? [])] as { id?: string }[];
    const next = mutate(current);
    if (next === current) return "unchanged";
    store.saves += 1;
    const footnotes = [...next];
    store.saved.push(footnotes);
    store.doc = { ...store.doc, footnotes };
    return "saved";
  },
}));

function mark(patch: Partial<DocFootnote> = {}): DocFootnote {
  return {
    id: "fn-1",
    kind: "ai",
    anchor: { kind: "text", start: 1, end: 6 },
    excerpt: "lemma",
    createdAt: 1,
    pending: "fr-1",
    ...patch,
  };
}

describe("applyFootnoteResult", () => {
  it("fills notes, clears pending, and leaves other marks alone", () => {
    const other = mark({ id: "fn-2", pending: "fr-2" });
    const next = applyFootnoteResult([mark(), other], {
      id: "fr-1",
      notes: ["  A lemma is a small theorem.  ", "Used on the way to the result."],
    }, 50);
    expect(next[0]?.pending).toBeUndefined();
    expect(next[0]?.notes?.map((note) => note.text)).toEqual([
      "A lemma is a small theorem.",
      "Used on the way to the result.",
    ]);
    expect(next[0]?.notes?.[0]?.id).not.toBe(next[0]?.notes?.[1]?.id);
    expect(next[0]?.notes?.[0]?.createdAt).toBe(50);
    expect(next[1]).toBe(other);
  });

  it("appends after notes the reader already wrote", () => {
    const reader = { id: "nt-reader", text: "my note", createdAt: 2, updatedAt: 2 };
    const next = applyFootnoteResult(
      [mark({ notes: [reader] })],
      { id: "fr-1", notes: ["from GrokBot"] },
      80,
    );
    expect(next[0]?.notes?.map((note) => note.text)).toEqual(["my note", "from GrokBot"]);
    expect(next[0]?.notes?.[0]).toEqual(reader);
  });

  it("adds links and skips a url the mark already has", () => {
    const next = applyFootnoteResult(
      [mark({ userLinks: [{ title: "Kept", url: "https://example.com/a" }] })],
      {
        id: "fr-1",
        notes: ["see"],
        links: [
          { title: "Duplicate", url: "https://example.com/a" },
          { url: " https://example.com/b " },
          { title: " Named ", url: "https://example.com/c" },
        ],
      },
    );
    expect(next[0]?.userLinks).toEqual([
      { title: "Kept", url: "https://example.com/a" },
      { url: "https://example.com/b" },
      { title: "Named", url: "https://example.com/c" },
    ]);
    expect(next[0]?.pending).toBeUndefined();
  });

  it("is a no-op when no footnote is waiting on that request", () => {
    const list = [mark({ pending: "fr-other" }), mark({ id: "fn-2", pending: undefined })];
    expect(applyFootnoteResult(list, { id: "fr-1", notes: ["unused"] })).toBe(list);
  });
});

describe("applyFootnotePing", () => {
  function fakeClient() {
    const acks: string[] = [];
    const client = {
      postFootnoteRequest: async () => {},
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
      },
    } as unknown as LcClient;
    return { client, acks };
  }

  const ping = {
    footnote_results: [{ id: "fr-1", doc_id: "doc-1", result: { notes: ["answer"] } }],
  };

  it("does not ack while the open editor lacks the mark the saved copy still has", async () => {
    store.doc = { id: "doc-1", name: "Doc", footnotes: [mark()] };
    store.saves = 0;
    const unregister = registerOpenAnnotateFootnotes({
      docId: () => "doc-1",
      write: async (_docId, mutate) => (mutate([]).length === 0 ? "gone" : "saved"),
    });
    const { client, acks } = fakeClient();
    try {
      await applyFootnotePing(client, ping);
    } finally {
      unregister();
    }
    expect(acks).toEqual([]);
    expect(store.saves).toBe(0);
  });

  it("writes the saved copy and acks when the document is not open", async () => {
    store.doc = { id: "doc-1", name: "Doc", footnotes: [mark()] };
    store.saves = 0;
    const { client, acks } = fakeClient();
    await applyFootnotePing(client, ping);
    expect(store.saves).toBe(1);
    expect(acks).toEqual(["fr-1"]);
  });

  it("acks without writing when the mark is gone everywhere", async () => {
    store.doc = { id: "doc-1", name: "Doc", footnotes: [] };
    store.saves = 0;
    const { client, acks } = fakeClient();
    await applyFootnotePing(client, ping);
    expect(store.saves).toBe(0);
    expect(acks).toEqual(["fr-1"]);
  });

  it("retries a failed acknowledgement without duplicating notes or links", async () => {
    store.doc = {
      id: "doc-1",
      name: "Doc",
      footnotes: [mark({ userLinks: [{ url: "https://example.com/kept" }] })],
    };
    store.saves = 0;
    store.saved = [];
    let failAck = true;
    const acks: string[] = [];
    const client = {
      postFootnoteRequest: async () => {},
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
        if (failAck) throw new Error("ack failed");
      },
    } as unknown as LcClient;
    const again = {
      footnote_results: [{
        id: "fr-1",
        doc_id: "doc-1",
        result: {
          notes: ["answer"],
          links: [{ url: "https://example.com/a" }, { url: "https://example.com/kept" }],
        },
      }],
    };
    await applyFootnotePing(client, again);
    expect(acks).toEqual(["fr-1"]);
    failAck = false;
    await applyFootnotePing(client, again);
    expect(acks).toEqual(["fr-1", "fr-1"]);
    const saved = store.doc?.footnotes[0] as DocFootnote;
    expect(saved.notes?.map((note) => note.text)).toEqual(["answer"]);
    expect(saved.userLinks).toEqual([
      { url: "https://example.com/kept" },
      { url: "https://example.com/a" },
    ]);
    expect(saved.pending).toBeUndefined();
    expect(store.saves).toBe(1);
  });
});

describe("footnote request queue", () => {
  const QUEUE_KEY = "whiteboard.footnoteRequests.v1";
  const AWAITING_KEY = "whiteboard.footnoteAwaiting.v1";
  let restoreStorage: (() => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        get length() {
          return values.size;
        },
        clear() {
          values.clear();
        },
        getItem(key: string) {
          return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          values.set(key, value);
        },
        removeItem(key: string) {
          values.delete(key);
        },
        key(index: number) {
          return [...values.keys()][index] ?? null;
        },
      },
    });
    restoreStorage = () => {
      if (prior) Object.defineProperty(globalThis, "localStorage", prior);
      else Reflect.deleteProperty(globalThis, "localStorage");
    };
    store.doc = null;
    store.saves = 0;
    store.saved = [];
  });

  afterEach(() => {
    restoreStorage?.();
    vi.unstubAllGlobals();
  });

  function body(id: string, docId = "doc-1"): FootnoteRequestDto {
    return {
      id,
      device_id: "device-1",
      doc_id: docId,
      doc_name: "Doc",
      page: 1,
      anchor: { kind: "text", start: 1, end: 6 },
      excerpt: id,
      context: id,
      wide_context: id,
      page_footnotes: [],
      prompt: null,
    };
  }

  async function stored(key: string): Promise<{ id: string; docId?: string }[]> {
    const rows = await readFootnoteOutbox();
    return key === QUEUE_KEY ? rows.flatMap(row => row.request ? [row.request] : []) : rows.map(({ id, docId }) => ({ id, docId }));
  }

  function noteCount(text: string): number {
    let count = 0;
    for (const footnotes of store.saved) {
      for (const entry of footnotes) {
        const notes = (entry as { notes?: { text?: string }[] } | null)?.notes;
        if (!Array.isArray(notes)) continue;
        for (const note of notes) {
          if (note?.text === text) count += 1;
        }
      }
    }
    return count;
  }

  async function load() {
    vi.resetModules();
    return import("./footnoteRequests");
  }

  function deferred() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { opened, release };
  }

  it("keeps a request enqueued during a flush for the next flush to send", async () => {
    const mod = await load();
    const posted: string[] = [];
    const hold = deferred();
    const started = deferred();
    const client = {
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
        if (item.id === "fr-a") {
          started.release();
          await hold.opened;
        }
      },
      ackFootnoteRequest: async () => {},
    } as unknown as LcClient;

    await mod.enqueueFootnoteRequest(body("fr-a"));
    expect((await stored(QUEUE_KEY)).map((entry) => entry.id)).toEqual(["fr-a"]);
    const first = mod.flushFootnoteQueue(client);
    await started.opened;
    await mod.enqueueFootnoteRequest(body("fr-b"));
    expect((await stored(QUEUE_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);
    const second = mod.flushFootnoteQueue(client);
    hold.release();
    await first;
    await second;

    expect(posted).toEqual(["fr-a", "fr-b"]);
    expect(await stored(QUEUE_KEY)).toEqual([]);
    expect((await stored(AWAITING_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);
  });

  it("keeps a transient failure and a request enqueued during it, in order", async () => {
    const mod = await load();
    const posted: string[] = [];
    const hold = deferred();
    const started = deferred();
    let failA = true;
    const client = {
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
        if (item.id === "fr-a" && failA) {
          started.release();
          await hold.opened;
          throw new TypeError("network down");
        }
      },
      ackFootnoteRequest: async () => {},
    } as unknown as LcClient;

    await mod.enqueueFootnoteRequest(body("fr-a"));
    const first = mod.flushFootnoteQueue(client);
    await started.opened;
    await mod.enqueueFootnoteRequest(body("fr-b"));
    hold.release();
    await first;

    expect(posted).toEqual(["fr-a"]);
    expect((await stored(QUEUE_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);
    expect((await stored(AWAITING_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);

    failA = false;
    posted.length = 0;
    await mod.flushFootnoteQueue(client);

    expect(posted).toEqual(["fr-a", "fr-b"]);
    expect(await stored(QUEUE_KEY)).toEqual([]);
    expect((await stored(AWAITING_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);
  });

  it("keeps an enqueue that overlaps a ping and applies that answer once", async () => {
    const mod = await load();
    store.doc = {
      id: "doc-1",
      name: "Doc",
      footnotes: [mark({ id: "fn-old", pending: "fr-old" })],
    };
    const posted: string[] = [];
    const acks: string[] = [];
    const hold = deferred();
    const started = deferred();
    const client = {
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
        if (item.id === "fr-a") {
          started.release();
          await hold.opened;
        }
      },
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
      },
    } as unknown as LcClient;

    await mod.enqueueFootnoteRequest(body("fr-a"));
    const flushing = mod.flushFootnoteQueue(client);
    await started.opened;
    await mod.enqueueFootnoteRequest(body("fr-b"));
    const ping = mod.applyFootnotePing(client, {
      footnote_results: [{ id: "fr-old", doc_id: "doc-1", result: { notes: ["from the hub"] } }],
    });
    hold.release();
    await flushing;
    await ping;

    expect(posted).toEqual(["fr-a", "fr-b"]);
    expect(await stored(QUEUE_KEY)).toEqual([]);
    expect((await stored(AWAITING_KEY)).map((entry) => entry.id)).toEqual(["fr-a", "fr-b"]);
    expect(acks).toEqual(["fr-old"]);
    expect(noteCount("from the hub")).toBe(1);
    expect(store.saves).toBe(1);
  });

  it("keeps a sent request awaiting until its result is applied and acknowledged", async () => {
    const mod = await load();
    store.doc = {
      id: "doc-1",
      name: "Doc",
      footnotes: [mark({ pending: "fr-a" })],
    };
    const posted: string[] = [];
    const acks: string[] = [];
    const client = {
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
      },
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
      },
    } as unknown as LcClient;

    await mod.enqueueFootnoteRequest(body("fr-a"));
    expect((await stored(QUEUE_KEY)).map((entry) => entry.id)).toEqual(["fr-a"]);
    expect(await stored(AWAITING_KEY)).toEqual([{ id: "fr-a", docId: "doc-1" }]);

    await mod.flushFootnoteQueue(client);

    expect(posted).toEqual(["fr-a"]);
    expect(await stored(QUEUE_KEY)).toEqual([]);
    expect(await stored(AWAITING_KEY)).toEqual([{ id: "fr-a", docId: "doc-1" }]);

    await mod.applyFootnotePing(client, {
      footnote_results: [{ id: "fr-a", doc_id: "doc-1", result: { notes: ["the answer"] } }],
    });

    expect(acks).toEqual(["fr-a"]);
    expect(await stored(AWAITING_KEY)).toEqual([]);
    expect(noteCount("the answer")).toBe(1);
    expect(store.saves).toBe(1);
  });

  it("applies an answer while a request upload is still in flight", async () => {
    const mod = await load();
    store.doc = {
      id: "doc-1",
      name: "Doc",
      footnotes: [mark({ pending: "fr-old" })],
    };
    store.saves = 0;
    store.saved = [];
    const hold = deferred();
    const started = deferred();
    const client = {
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        if (item.id === "fr-a") {
          started.release();
          await hold.opened;
        }
      },
      ackFootnoteRequest: async () => {},
    } as unknown as LcClient;
    await mod.enqueueFootnoteRequest(body("fr-a"));
    const flushing = mod.flushFootnoteQueue(client);
    await started.opened;
    const pinging = mod.applyFootnotePing(client, {
      footnote_results: [{ id: "fr-old", doc_id: "doc-1", result: { notes: ["from the hub"] } }],
    });
    try {
      await vi.waitFor(() => {
        expect(store.saves).toBe(1);
      }, { timeout: 300, interval: 10 });
    } finally {
      hold.release();
      await flushing;
      await pinging;
    }
    expect(noteCount("from the hub")).toBe(1);
  });

  it("polls footnote results without a pad sync and still sends the queue", async () => {
    debugLog.mockClear();
    store.doc = {
      id: "doc-1",
      name: "Doc",
      footnotes: [mark({ pending: "fr-old" })],
    };
    store.saves = 0;
    store.saved = [];
    const mod = await load();
    const ping = vi.fn(async () => ({
      footnote_results: [{ id: "fr-old", doc_id: "doc-1", result: { notes: ["from pad sync"] } }],
    }));
    const posted: string[] = [];
    const acks: string[] = [];
    await mod.enqueueFootnoteRequest(body("fr-a"));
    await mod.pollFootnoteInbox({
      pingPadSync: ping,
      footnoteResults: async () => [{ id: "fr-old", doc_id: "doc-1", result: { notes: ["from results"] } }],
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
      },
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
      },
    } as unknown as LcClient);
    expect(ping).not.toHaveBeenCalled();
    expect(posted).toEqual(["fr-a"]);
    expect(acks).toEqual(["fr-old"]);
    expect(noteCount("from results")).toBe(1);
    expect(noteCount("from pad sync")).toBe(0);
    expect(debugLog).not.toHaveBeenCalled();
  });

  it("keeps the queue when an old hub has no footnote-results route", async () => {
    debugLog.mockClear();
    const mod = await load();
    const { LcApiError } = await import("../api/client");
    const ping = vi.fn(async () => ({ footnote_results: [] as { id: string }[] }));
    const results = vi.fn(async () => {
      throw new LcApiError("missing", 404);
    });
    const posted: string[] = [];
    await mod.enqueueFootnoteRequest(body("fr-a"));
    const client = {
      pingPadSync: ping,
      footnoteResults: results,
      postFootnoteRequest: async (item: FootnoteRequestDto) => {
        posted.push(item.id);
      },
      ackFootnoteRequest: async () => {},
    } as unknown as LcClient;
    await mod.pollFootnoteInbox(client);
    await mod.pollFootnoteInbox(client);
    expect(ping).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect((await stored(QUEUE_KEY)).map((entry) => entry.id)).toEqual(["fr-a"]);
    expect(await stored(AWAITING_KEY)).toEqual([{ id: "fr-a", docId: "doc-1" }]);
    expect(results).toHaveBeenCalledTimes(2);
    expect(debugLog).toHaveBeenCalledTimes(1);
    expect(debugLog).toHaveBeenCalledWith({
      k: "error",
      n: "footnote-results",
      e: "hub has no /footnote-results",
    });
  });
});
