import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { bookWireRecord } from "./bookWireRecord";
import { canonicalJson, recordHash } from "./syncContent";
import { captureBook } from "./bookSnapshot";
import { closeDbForTests, withStore, STORE_BOOK_META, STORE_CONTENT } from "./idb";
import { resetBookCoordinatorForTests } from "./bookCoordinator";

beforeEach(async () => {
  await closeDbForTests(); resetBookCoordinatorForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(async () => { await closeDbForTests(); resetBookCoordinatorForTests(); vi.unstubAllGlobals(); });

it("uses the existing Markdown default when a historical note has no document type", async () => {
  const metadata = { kind: "annotate", id: "old-note", name: "Old note.md", hash: "md-history", updatedAt: 1 };
  const payload = { source: "# Kept source", board: { v: 1, elements: [], appState: {} }, agent: undefined };
  await withStore(STORE_BOOK_META, "readwrite", store => { store.put(metadata, "annotate:old-note"); });
  await withStore(STORE_CONTENT, "readwrite", store => { store.put(payload, "old-note"); });
  const captured = await captureBook({ kind: "annotate", id: "old-note" });
  expect(captured.record).toMatchObject({ doc_type: "markdown", source: payload.source, agent: [] });
  await expect(recordHash(captured.record)).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(captured.metadata).toStrictEqual(metadata); expect(captured.payload).toStrictEqual(payload);
});

it("encodes absent drawing DTO options while retaining the complete program and defined options", async () => {
  const original = { agent: [{ drawing: { program: { id: "program", future: { kept: true } }, expanded: false,
    page: undefined, redacted: undefined, frameIndex: undefined } },
    { drawing: { program: { id: "second" }, expanded: true, page: 2, redacted: false, frameIndex: 0 } }] };
  const wire = bookWireRecord(original);
  expect(wire).toStrictEqual(JSON.parse(JSON.stringify(original)));
  await expect(recordHash(wire)).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(Object.hasOwn(original.agent[0]!.drawing, "redacted")).toBe(true);
  expect(original.agent[0]!.drawing.program.future).toEqual({ kept: true });
});

it("still rejects unsupported unknown drawing or program fields without omitting them", () => {
  for (const drawing of [{ future: undefined }, { program: { redacted: undefined } }]) {
    const wire = bookWireRecord({ agent: [{ drawing }] });
    expect(() => canonicalJson(wire)).toThrow("unsupported JSON value");
  }
});
