import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

import type { DocFootnote } from "./docFootnotes";
import { applyFootnotePing, applyFootnoteResult, registerOpenAnnotateFootnotes } from "./footnoteRequests";
import type { LcClient } from "../api/client";
import {
  completeAnnotateSave,
  footnotesPendingSave,
  settleOpenFootnoteWrite,
  type HeldFootnoteAsk,
} from "./footnoteSaveBaseline";

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

function withReaderNote(footnotes: readonly DocFootnote[], text = "reader note"): DocFootnote[] {
  return footnotes.map((entry, index) => {
    if (index !== 0) return entry;
    return {
      ...entry,
      notes: [
        ...(entry.notes ?? []),
        { id: "nt-reader", text, createdAt: 9, updatedAt: 9 },
      ],
    };
  });
}

function noteTexts(footnotes: readonly DocFootnote[] | null | undefined): string[] {
  return (footnotes?.[0]?.notes ?? []).map((note) => note.text);
}

function deferred() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe("footnote save baseline", () => {
  it("keeps a reader note dirty when it lands while an answer save is in flight", async () => {
    const live = { current: [mark()] as DocFootnote[] };
    const pristine = { current: "" };
    const started = deferred();
    const release = deferred();
    let captured: DocFootnote[] = [];

    const done = settleOpenFootnoteWrite({
      docId: "doc-1",
      openDocId: "doc-1",
      live,
      pristine,
      mutate: (footnotes) => applyFootnoteResult(footnotes, { id: "fr-1", notes: ["from GrokBot"] }, 50),
      publish: (next) => {
        live.current = next;
      },
      save: async () => {
        captured = live.current.map((entry) => ({
          ...entry,
          notes: entry.notes?.map((note) => ({ ...note })),
        }));
        started.release();
        await release.opened;
        return { id: "doc-1", footnotes: captured };
      },
    });

    await started.opened;
    live.current = withReaderNote(live.current);
    release.release();
    expect(await done).toBe("saved");

    expect(noteTexts(captured)).toEqual(["from GrokBot"]);
    expect(noteTexts(footnotesPendingSave(live.current, pristine.current))).toEqual([
      "from GrokBot",
      "reader note",
    ]);
  });

  it("keeps a reader note dirty when it lands while a pending GrokBot footnote is saving", async () => {
    const live = { current: [mark({ pending: "fr-a" })] };
    const pristine = { current: "" };
    const held: HeldFootnoteAsk[] = [{ requestId: "fr-a", footnoteId: "fn-1" }];
    const started = deferred();
    const release = deferred();
    let captured: DocFootnote[] = [];

    const done = (async () => {
      const saving = (async () => {
        captured = live.current.map((entry) => ({ ...entry, notes: entry.notes?.map((note) => ({ ...note })) }));
        started.release();
        await release.opened;
        return { id: "doc-1", footnotes: captured };
      })();
      const saved = await saving;
      return completeAnnotateSave({
        saved,
        live: live.current,
        pristine,
        held,
      });
    })();

    await started.opened;
    live.current = withReaderNote(live.current);
    release.release();
    const delivered = await done;

    expect(delivered.send.map((ask) => ask.requestId)).toEqual(["fr-a"]);
    expect(noteTexts(captured)).toEqual([]);
    expect(live.current[0]?.pending).toBe("fr-a");
    expect(noteTexts(footnotesPendingSave(live.current, pristine.current))).toEqual(["reader note"]);
  });

  it("does not send a request whose pending mark was not saved, and keeps the reader note", () => {
    const live = {
      current: [mark({
        pending: "fr-a",
        notes: [{ id: "nt-reader", text: "reader note", createdAt: 9, updatedAt: 9 }],
      })],
    };
    const pristine = { current: "" };
    const held: HeldFootnoteAsk[] = [{ requestId: "fr-a", footnoteId: "fn-1" }];

    const failed = completeAnnotateSave({
      saved: null,
      live: live.current,
      pristine,
      held,
    });
    expect(failed.send).toEqual([]);
    expect(failed.keep).toEqual(held);
    expect(pristine.current).toBe("");
    expect(live.current[0]?.pending).toBe("fr-a");
    expect(noteTexts(live.current)).toEqual(["reader note"]);

    const missing = completeAnnotateSave({
      saved: { id: "doc-old", footnotes: [] },
      live: live.current,
      pristine,
      held: failed.keep,
    });
    expect(missing.send).toEqual([]);
    expect(missing.keep).toEqual(held);
    expect(live.current[0]?.pending).toBe("fr-a");
    expect(noteTexts(live.current)).toEqual(["reader note"]);

    const retried = completeAnnotateSave({
      saved: { id: "doc-1", footnotes: live.current },
      live: live.current,
      pristine,
      held: missing.keep,
    });
    expect(retried.send).toEqual(held);
    expect(retried.keep).toEqual([]);
    expect(noteTexts(footnotesPendingSave(live.current, pristine.current))).toEqual([]);
  });

  it("leaves a failed answer save unacknowledged and keeps the reader note", async () => {
    const live = { current: [mark()] as DocFootnote[] };
    const pristine = { current: "before" };
    const started = deferred();
    const release = deferred();
    const acks: string[] = [];
    const client = {
      postFootnoteRequest: async () => {},
      ackFootnoteRequest: async (id: string) => {
        acks.push(id);
      },
    } as unknown as LcClient;
    const unregister = registerOpenAnnotateFootnotes({
      docId: () => "doc-1",
      write: (docId, mutate) => settleOpenFootnoteWrite({
        docId,
        openDocId: "doc-1",
        live,
        pristine,
        mutate,
        publish: (next) => {
          live.current = next;
        },
        save: async () => {
          started.release();
          await release.opened;
          return null;
        },
      }),
    });

    const ping = applyFootnotePing(client, {
      footnote_results: [{ id: "fr-1", doc_id: "doc-1", result: { notes: ["from GrokBot"] } }],
    });
    await started.opened;
    live.current = withReaderNote(live.current);
    release.release();
    try {
      await ping;
    } finally {
      unregister();
    }

    expect(acks).toEqual([]);
    expect(pristine.current).toBe("before");
    expect(noteTexts(live.current)).toEqual(["from GrokBot", "reader note"]);
    expect(footnotesPendingSave(live.current, pristine.current)).not.toBeNull();
  });

  it("does not accept an answer whose save landed in a different document", async () => {
    const live = { current: [mark()] as DocFootnote[] };
    const pristine = { current: "clean" };
    const outcome = await settleOpenFootnoteWrite({
      docId: "doc-1",
      openDocId: "doc-1",
      live,
      pristine,
      mutate: (footnotes) => applyFootnoteResult(footnotes, { id: "fr-1", notes: ["from GrokBot"] }, 50),
      publish: (next) => {
        live.current = next;
      },
      save: async () => ({ id: "doc-2", footnotes: live.current }),
    });
    expect(outcome).toBe("failed");
    expect(pristine.current).toBe("clean");
  });
});
