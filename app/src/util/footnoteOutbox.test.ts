import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FootnoteRequestDto } from "../api/client";
import { LEGACY_FOOTNOTE_QUEUE as QUEUE, LEGACY_FOOTNOTE_AWAITING as WAITING,
  readFootnoteOutbox, storeFootnoteRequest, markFootnoteRequestSent, forgetFootnoteRequest } from "./footnoteOutbox";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const body = (id: string) => ({ id, doc_id: "book" } as FootnoteRequestDto);

it("imports both old queues, preserves order, and never resurrects acknowledged requests", async () => {
  localStorage.setItem(QUEUE, JSON.stringify([body("z"), body("a")]));
  localStorage.setItem(WAITING, JSON.stringify([{ id: "sent", docId: "book" }]));
  expect((await readFootnoteOutbox()).map(r => r.id)).toEqual(["sent", "z", "a"]);
  expect(localStorage.getItem(QUEUE)).toBeNull();
  await forgetFootnoteRequest("z");
  localStorage.setItem(QUEUE, JSON.stringify([body("z")])); // Simulate unsuccessful legacy cleanup.
  expect((await readFootnoteOutbox()).map(r => r.id)).toEqual(["sent", "a"]);
});

it("retains legacy requests and propagates quota errors when migration cannot commit", async () => {
  localStorage.setItem(QUEUE, JSON.stringify([body("pending")]));
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  await expect(readFootnoteOutbox()).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(localStorage.getItem(QUEUE)).toContain("pending");
  put.mockRestore();
  expect((await readFootnoteOutbox())[0]?.id).toBe("pending");
});

it("works when localStorage writes are full and only removes a request after acknowledgement", async () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  await storeFootnoteRequest(body("first"));
  await storeFootnoteRequest(body("second"));
  await markFootnoteRequestSent("first");
  expect(await readFootnoteOutbox()).toEqual([
    { id: "first", docId: "book", order: 1 }, { id: "second", docId: "book", order: 2, request: body("second") },
  ]);
  await forgetFootnoteRequest("first");
  expect((await readFootnoteOutbox()).map(r => r.id)).toEqual(["second"]);
});


it("rejects a full request database visibly, retains earlier requests, and permits a retry", async () => {
  await storeFootnoteRequest(body("saved"));
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  await expect(storeFootnoteRequest(body("new"))).rejects.toMatchObject({ name: "QuotaExceededError" });
  put.mockRestore();
  expect((await readFootnoteOutbox()).map(row => row.id)).toEqual(["saved"]);
  await storeFootnoteRequest(body("new"));
  expect((await readFootnoteOutbox()).map(row => row.id)).toEqual(["saved", "new"]);
});

it("retains malformed legacy queues instead of silently dropping their entries", async () => {
  const original = JSON.stringify([body("valid"), { unexpected: true }]);
  localStorage.setItem(QUEUE, original);
  await expect(readFootnoteOutbox()).rejects.toThrow("unreadable entry");
  expect(localStorage.getItem(QUEUE)).toBe(original);
});


it("does not erase legacy writes made while their import commits", async () => {
  localStorage.setItem(QUEUE, JSON.stringify([body("initial")]));
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "requests") localStorage.setItem(QUEUE, JSON.stringify([body("later")]));
    return put.apply(this, args);
  });
  expect((await readFootnoteOutbox()).map(row => row.id)).toEqual(["initial"]);
  expect(localStorage.getItem(QUEUE)).toContain("later");
});
