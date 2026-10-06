import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ hub: null as null | { url: string; token: string }, invoke: vi.fn(), fetch: vi.fn() }));
vi.mock("./nativeHttp", async original => ({
  ...await original<typeof import("./nativeHttp")>(), loadInvoke: async () => transport.invoke,
}));
vi.mock("../util/padHub", async original => ({
  ...await original<typeof import("../util/padHub")>(), loadPadHub: () => transport.hub,
}));
vi.mock("../util/padHubStatus", async original => ({
  ...await original<typeof import("../util/padHubStatus")>(),
  isPadHubOffline: () => false, beginPadHubStatusRequest: vi.fn(), reportPadHubStatus: vi.fn(),
}));

import { LcClient, type BookStateDto, type CommitRequestDto } from "./client";

const client = new LcClient();
const uploadId = "11111111-1111-4111-8111-111111111111";
const key = "book/fn/scratch";
const state: BookStateDto = { kind: "annotate", id: "book", book_rev: 41, state: "live", gone_seq: null,
  record_rev: 14, record_hash: "record-hash", record: { id: "book", unknown: { kept: true } },
  pages: [{ key, page_id: 113, rev: 16, hash: "page-hash" }] };
const commit: CommitRequestDto = { upload_id: uploadId, kind: "annotate", id: "book", action: "upsert",
  record: { base_rev: 14, value: { id: "book", source: "original", unknown: { kept: true } } },
  pages: [{ key, page_id: 113, base_rev: 16, hash: "page-hash" }] };
const committed = { status: "committed", upload_id: uploadId, record_rev: 14, page_revs: state.pages, book: state };
const restore: CommitRequestDto = { ...commit, action: "restore", base_book_rev: 41, gone_seq: 7, seq: 8,
  record: { base_rev: 0, value: commit.record!.value },
  pages: [...commit.pages, { key: "book", page_id: 114, base_rev: 0, hash: "new-page-hash" }] };
const restoredPages = [{ ...state.pages[0], rev: 44 }, { key: "book", page_id: 114, rev: 45, hash: "new-page-hash" }];
const restored = { ...committed, record_rev: 42, page_revs: restoredPages,
  book: { ...state, book_rev: 45, record_rev: 42, pages: restoredPages } };
const snapshot = { kind: "annotate", key: "book", tier: "manual", written_at: 123, payload: { unknown: "kept" } };

function respond(body: unknown, status = 200): void {
  transport.invoke.mockResolvedValue({ status, body });
  transport.fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  transport.invoke.mockReset(); transport.fetch.mockReset(); transport.hub = null;
  vi.stubGlobal("fetch", transport.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const contracts = [
  { name: "book metadata", command: "lc_get_book_state", args: { kind: "annotate", id: "book" },
    method: "GET", path: "/pads/books/annotate/book", response: state, run: () => client.getBookState("annotate", "book") },
  { name: "book head", command: "lc_check_book_head", args: { kind: "annotate", id: "book", bookRev: 41 },
    method: "GET", path: "/pads/books/annotate/book/head?book_rev=41", response: { unchanged: true, book_rev: 41 }, run: () => client.checkBookHead("annotate", "book", 41) },
  { name: "revision-pinned ink", command: "lc_get_ink_page", args: { kind: "annotate", key, pageId: 113, bookRev: 41, pageRev: 16 },
    method: "GET", path: "/pads/ink/annotate/book%2Ffn%2Fscratch/113?book_rev=41&page_rev=16",
    response: { kind: "annotate", key, page_id: 113, updated_at: 1, rev: 16, hash: "page-hash", gz: "AQID" },
    run: () => client.getInkPage("annotate", key, 113, { bookRev: 41, pageRev: 16 }) },
  { name: "stage page", command: "lc_stage_ink_page", args: { uploadId, kind: "annotate", key, pageId: 113, body: { gz: "AQID" } },
    method: "PUT", path: `/pads/stage/${uploadId}/annotate/book%2Ffn%2Fscratch/113`, response: { staged: true, hash: "page-hash" },
    body: { gz: "AQID" }, run: () => client.stageInkPage(uploadId, "annotate", key, 113, "AQID") },
  { name: "staged inventory", command: "lc_list_staged", args: { uploadId }, method: "GET", path: `/pads/stage/${uploadId}`,
    response: [{ kind: "annotate", key, page_id: 113, hash: "page-hash" }], run: () => client.listStagedInk(uploadId) },
  { name: "commit", command: "lc_commit_pad", args: { body: commit }, method: "POST", path: "/pads/commit",
    body: commit, response: committed, run: () => client.commitPad(commit) },
  { name: "restore with retained revisions and base-zero new pages", command: "lc_commit_pad", args: { body: restore }, method: "POST", path: "/pads/commit",
    body: restore, response: restored, run: () => client.commitPad(restore) },
  { name: "commit receipt", command: "lc_get_pad_commit", args: { uploadId }, method: "GET", path: `/pads/commits/${uploadId}`,
    response: committed, run: () => client.getPadCommit(uploadId) },
  { name: "store backup copy", command: "lc_put_snapshot_copy", args: { kind: "annotate", key: "book", contentHash: "copy-hash", body: snapshot },
    method: "PUT", path: "/pads/snapshot-copies/annotate/book/copy-hash", body: snapshot, response: { content_hash: "copy-hash", tier: "manual", written_at: 123, name: "saved" },
    run: () => client.putSnapshotCopy("annotate", "book", "copy-hash", snapshot) },
  { name: "backup copy inventory", command: "lc_list_snapshot_copies", args: { kind: "annotate", key: "book" },
    method: "GET", path: "/pads/snapshot-copies/annotate/book", response: [{ content_hash: "copy-hash", tier: "manual", written_at: 123, name: "saved" }],
    run: () => client.listSnapshotCopies("annotate", "book") },
  { name: "read backup copy", command: "lc_get_snapshot_copy", args: { kind: "annotate", key: "book", contentHash: "copy-hash" },
    method: "GET", path: "/pads/snapshot-copies/annotate/book/copy-hash", response: snapshot,
    run: () => client.getSnapshotCopy("annotate", "book", "copy-hash") },
];

for (const mode of ["native", "HTTP"] as const) describe(`${mode} atomic-sync contract`, () => {
  beforeEach(() => { transport.hub = mode === "HTTP" ? { url: "http://hub.test", token: "123456" } : null; });
  for (const contract of contracts) it(contract.name, async () => {
    respond(contract.response);
    expect(await contract.run()).toEqual(contract.response);
    if (mode === "native") {
      expect(transport.invoke).toHaveBeenCalledTimes(1);
      expect(transport.invoke).toHaveBeenCalledWith(contract.command, contract.args);
      expect(transport.fetch).not.toHaveBeenCalled();
    } else {
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://hub.test${contract.path}`);
      expect(init.method).toBe(contract.method);
      expect(init.headers).toMatchObject({ "x-lc-token": "123456" });
      expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual("body" in contract ? contract.body : undefined);
      expect(transport.invoke).not.toHaveBeenCalled();
    }
  });

  it("preserves every structured conflict detail", async () => {
    const conflict = { status: "conflict", record: { hub_rev: 50 }, pages: [{ key, page_id: 113, hub_rev: 51 }, { key: "book", page_id: 44, hub_rev: 52 }] };
    respond(conflict, 409);
    await expect(client.commitPad(commit)).rejects.toMatchObject({ status: 409, json: conflict });
  });

  it("reports a changed head and missing receipt separately", async () => {
    respond({ ...state, book_rev: 50 }, 409);
    await expect(client.checkBookHead("annotate", "book", 41)).rejects.toMatchObject({ status: 409, json: { book_rev: 50 } });
    respond({ error: "No receipt" }, 404);
    expect(await client.getPadCommit(uploadId)).toBeNull();
    respond({ error: "No page" }, 404);
    expect(await client.getInkPage("annotate", key, 113, { bookRev: 41, pageRev: 16 })).toBeNull();
    expect(await client.getInkPage("annotate", key, 113)).toBeNull();
  });

  it("rejects malformed success without inventing an acknowledgement", async () => {
    respond({ status: "committed", upload_id: uploadId });
    await expect(client.commitPad(commit)).rejects.toMatchObject({ status: 502 });
    respond({ kind: "annotate", key, page_id: 113, gz: "AQID" });
    await expect(client.getInkPage("annotate", key, 113, { bookRev: 41, pageRev: 16 })).rejects.toMatchObject({ status: 502 });
    respond({ staged: false });
    await expect(client.stageInkPage(uploadId, "annotate", key, 113, "AQID")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects incoherent lifecycle and foreign or duplicated page metadata", async () => {
    for (const body of [
      { ...state, record: null }, { ...state, state: "gone", record: null, record_hash: null, record_rev: 0, gone_seq: 1 },
      { ...state, pages: [{ ...state.pages[0], key: "another-book" }] },
      { ...state, pages: [...state.pages, ...state.pages] },
    ]) {
      respond(body);
      await expect(client.getBookState("annotate", "book")).rejects.toMatchObject({ status: 502 });
    }
    respond({ ...committed, record_rev: 99 });
    await expect(client.commitPad(commit)).rejects.toMatchObject({ status: 502 });
    respond({ ...committed, page_revs: [{ ...state.pages[0], rev: 99 }] });
    await expect(client.commitPad(commit)).rejects.toMatchObject({ status: 502 });
  });

  it("keeps disclosed unpublished pages and gone/absent distinctions", async () => {
    const absent = { ...state, state: "absent", record: null, record_rev: 0, record_hash: null,
      retained_unpublished: true };
    respond(absent);
    expect(await client.getBookState("annotate", "book")).toEqual(absent);
    const gone = { ...state, state: "gone", gone_seq: 7, record: null, record_rev: 0, record_hash: null, pages: [] };
    respond(gone);
    expect(await client.getBookState("annotate", "book")).toEqual(gone);
  });

  it("preserves gone-book restore pages and reads them with both revision conditions", async () => {
    const gone = { ...state, state: "gone", gone_seq: 7, record: null, record_rev: 0,
      record_hash: null, pages: [], retained_restore_pages: state.pages };
    respond(gone);
    expect(await client.getBookState("annotate", "book")).toEqual(gone);
    const page = { kind: "annotate", key, page_id: 113, updated_at: 1, rev: 16, hash: "page-hash", gz: "AQID" };
    respond(page);
    expect(await client.getInkPage("annotate", key, 113, { bookRev: 41, pageRev: 16 })).toEqual(page);
    if (mode === "native") expect(transport.invoke).toHaveBeenLastCalledWith("lc_get_ink_page",
      { kind: "annotate", key, pageId: 113, bookRev: 41, pageRev: 16 });
    else expect(transport.fetch.mock.calls.at(-1)?.[0]).toBe("http://hub.test/pads/ink/annotate/book%2Ffn%2Fscratch/113?book_rev=41&page_rev=16");
  });

  it("rejects undisclosed, foreign, duplicated or invalid restore page vectors", async () => {
    const gone = { ...state, state: "gone", gone_seq: 7, record: null, record_rev: 0, record_hash: null, pages: [] };
    for (const body of [
      { ...state, retained_restore_pages: state.pages },
      { ...state, state: "absent", record: null, record_rev: 0, record_hash: null, pages: [], retained_restore_pages: state.pages },
      { ...gone, gone_seq: 0, retained_restore_pages: state.pages },
      { ...gone, retained_restore_pages: [{ ...state.pages[0], key: "another-book" }] },
      { ...gone, retained_restore_pages: [...state.pages, ...state.pages] },
      { ...gone, retained_restore_pages: [{ ...state.pages[0], page_id: -1 }] },
      { ...gone, retained_restore_pages: [{ ...state.pages[0], rev: 0 }] },
    ]) {
      respond(body);
      await expect(client.getBookState("annotate", "book")).rejects.toMatchObject({ status: 502 });
    }
  });

  it("bounds unanswered requests and leaves no request timer", async () => {
    vi.useFakeTimers();
    transport.invoke.mockReturnValue(new Promise(() => {}));
    transport.fetch.mockReturnValue(new Promise(() => {}));
    const result = expect(client.getBookState("annotate", "book", { timeoutMs: 10 })).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(mode === "native" ? transport.invoke : transport.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stage attempt from decoded binary size", async () => {
    vi.useFakeTimers();
    transport.invoke.mockReturnValue(new Promise(() => {}));
    transport.fetch.mockReturnValue(new Promise(() => {}));
    const gz = btoa("x".repeat(262_145));
    const result = expect(client.stageInkPage(uploadId, "annotate", key, 113, gz)).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(31_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("does not hide a network retry inside any modern read", async () => {
  transport.hub = { url: "http://hub.test", token: "123456" };
  transport.fetch.mockRejectedValue(new TypeError("Network interrupted"));
  for (const contract of contracts.filter(value => value.method === "GET")) {
    transport.fetch.mockClear();
    await expect(contract.run()).rejects.toMatchObject({ status: 0 });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  }
  transport.fetch.mockClear();
  await expect(client.pingPadSync(0, {})).rejects.toMatchObject({ status: 0 });
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it("preserves healthy and unreadable books in the same inventory", async () => {
  const bad = { kind: "annotate", id: "bad", book_rev: 99, error: { status: "unreadable_content", message: "Cannot read ink" } };
  respond({ now: 10, whiteboard: [], annotate: [], snapshots: [], books: [state, bad], errors: [bad] });
  const inventory = await client.pingPadSync(0);
  expect(inventory.books).toEqual([state, bad]); expect(inventory.errors).toEqual([bad]);
});
