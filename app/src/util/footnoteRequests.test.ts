import { describe, expect, it, vi } from "vitest";

import type { LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";
import { applyFootnotePing, applyFootnoteResult, registerOpenAnnotateFootnotes } from "./footnoteRequests";

const store = vi.hoisted(() => ({
  doc: null as null | { id: string; name: string; footnotes: unknown[] },
  saves: 0,
}));

vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async () => store.doc,
  saveAnnotateDoc: async () => {
    store.saves += 1;
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
});
