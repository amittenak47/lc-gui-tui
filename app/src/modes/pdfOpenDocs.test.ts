import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquirePdfDocument,
  borrowPdfDocument,
  dropPdfDocument,
  lendPdfDocument,
  pdfDocumentOpenFor,
  pdfDocumentRefs,
  resetPdfOpenDocsForTests,
} from "./pdfOpenDocs";

afterEach(() => {
  resetPdfOpenDocsForTests();
});

/** A `getDocument` that never settles until told to. */
function deferredOpen(doc: unknown) {
  const task = { destroy: vi.fn() };
  let settle: () => void = () => {};
  const promise = new Promise<never>((resolve) => {
    settle = () => resolve(doc as never);
  });
  const start = vi.fn(() => ({ promise, task }));
  return { start, task, settle };
}

describe("pdfOpenDocs", () => {
  it("lends by hash and drops only that instance", () => {
    const first = { numPages: 1 } as never;
    const second = { numPages: 2 } as never;
    lendPdfDocument("binabc-k", first);
    expect(borrowPdfDocument("binabc-k")).toBe(first);
    dropPdfDocument("binabc-k", second);
    expect(borrowPdfDocument("binabc-k")).toBe(first);
    dropPdfDocument("binabc-k", first);
    expect(borrowPdfDocument("binabc-k")).toBeNull();
  });
});

describe("acquirePdfDocument", () => {
  it("parses a textbook once for two panes that start together", async () => {
    const doc = { numPages: 400 };
    const { start, settle } = deferredOpen(doc);
    // Both panes mount in the same commit — neither can see a finished
    // document, which is exactly when this used to parse the book twice.
    const local = acquirePdfDocument("h", start);
    const server = acquirePdfDocument("h", start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(local.joined).toBe(false);
    expect(server.joined).toBe(true);
    settle();
    expect(await local.promise).toBe(doc);
    expect(await server.promise).toBe(doc);
  });

  it("does not destroy the document when the first pane unmounts", async () => {
    const doc = { numPages: 2 };
    const { start, task, settle } = deferredOpen(doc);
    const local = acquirePdfDocument("h", start);
    const server = acquirePdfDocument("h", start);
    settle();
    await local.promise;
    local.release();
    expect(task.destroy).not.toHaveBeenCalled();
    expect(borrowPdfDocument("h")).toBe(doc);
    server.release();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(borrowPdfDocument("h")).toBeNull();
  });

  it("releases once however often a teardown runs", async () => {
    const doc = { numPages: 1 };
    const { start, task, settle } = deferredOpen(doc);
    const only = acquirePdfDocument("h", start);
    settle();
    await only.promise;
    only.release();
    only.release();
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("lends the settled document so the indexer can peek at it", async () => {
    const doc = { numPages: 3 };
    const { start, settle } = deferredOpen(doc);
    const lease = acquirePdfDocument("h", start);
    // Opening counts before it settles: a pane with no bytes of its own is
    // not empty-handed while the file is on its way.
    expect(pdfDocumentOpenFor("h")).toBe(true);
    expect(borrowPdfDocument("h")).toBeNull();
    settle();
    await lease.promise;
    expect(borrowPdfDocument("h")).toBe(doc);
    lease.release();
  });

  it("lets the next caller try again after a failed open", async () => {
    const task = { destroy: vi.fn() };
    const boom = Promise.reject(new Error("Invalid PDF structure"));
    const first = acquirePdfDocument("h", () => ({ promise: boom as never, task }));
    await expect(first.promise).rejects.toThrow("Invalid PDF structure");
    // Joining a rejection forever would mean one bad open poisoned the file.
    await Promise.resolve();
    expect(pdfDocumentOpenFor("h")).toBe(false);
    const doc = { numPages: 1 };
    const retry = deferredOpen(doc);
    const second = acquirePdfDocument("h", retry.start);
    expect(second.joined).toBe(false);
    retry.settle();
    expect(await second.promise).toBe(doc);
    first.release();
    second.release();
  });

  it("keeps a hashless open to itself — there is nothing to key on", async () => {
    const a = deferredOpen({ numPages: 1 });
    const b = deferredOpen({ numPages: 1 });
    const one = acquirePdfDocument(undefined, a.start);
    const two = acquirePdfDocument(undefined, b.start);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(b.start).toHaveBeenCalledTimes(1);
    expect(two.joined).toBe(false);
    one.release();
    two.release();
    expect(a.task.destroy).toHaveBeenCalledTimes(1);
    expect(b.task.destroy).toHaveBeenCalledTimes(1);
  });

  it("counts holders across a re-acquire, so a prop change does not re-parse", async () => {
    const doc = { numPages: 9 };
    const { start, task, settle } = deferredOpen(doc);
    const local = acquirePdfDocument("h", start);
    const server = acquirePdfDocument("h", start);
    settle();
    await local.promise;
    expect(pdfDocumentRefs("h")).toBe(2);
    // One pane's `bytes` identity changed: React tears down, then re-runs.
    local.release();
    const again = acquirePdfDocument("h", start);
    expect(again.joined).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(task.destroy).not.toHaveBeenCalled();
    again.release();
    server.release();
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });
});
