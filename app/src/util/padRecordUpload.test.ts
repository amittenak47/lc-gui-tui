import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotatePadDto, InkPageDto, LcClient, WhiteboardPadDto } from "../api/client";
import { gzipSync } from "fflate";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { putPadRecord } from "./padRecordUpload";

const store = vi.hoisted(() => ({ rows: new Map<string, Array<{ pageId: number; updatedAt: number; gz: Uint8Array }>>() }));
vi.mock("./inkPageStore", async (original) => ({
  ...await original<typeof import("./inkPageStore")>(),
  getInkPageRecords: async (key: string) => store.rows.get(key) ?? [],
  getInkPageRecord: async (key: string, pageId: number) => store.rows.get(key)?.find((r) => r.pageId === pageId) ?? null,
  markInkPageSynced: async () => {},
}));
vi.mock("./annotateStore", () => ({ getAnnotateDoc: async () => null }));
vi.mock("./padHub", () => ({ loadPadHub: () => ({ url: "http://hub.test" }), loadPadSyncSince: () => 0 }));

beforeEach(() => store.rows.clear());

describe.each(["annotate", "whiteboard"] as const)("%s ink before record", (kind) => {
  function fixture() {
    const events: string[] = [];
    const hubInk = new Map<number, InkPageDto>();
    let hubRecord: unknown = null;
    store.rows.set(`${kind === "annotate" ? "md" : "wb"}:book`, [{ pageId: 113, updatedAt: 10, gz: gzipSync(packEncodedInk(encodeInkOps([]))) }]);
    const record = vi.fn(async (_id: string, body: AnnotatePadDto | WhiteboardPadDto) => {
      events.push("record");
      expect(hubInk.has(113)).toBe(true);
      hubRecord = body;
      return body;
    });
    const client = {
      pingPadSync: vi.fn(async () => ({ ink: [] })),
      putInkPage: vi.fn(async (page: InkPageDto) => { events.push("ink"); hubInk.set(page.page_id, page); }),
      putAnnotatePad: record, putWhiteboardPad: record,
    } as unknown as LcClient;
    const body = { id: "book", updated_at: 10, board: { inkPages: { v: 1, pageIds: [113] } } } as AnnotatePadDto;
    return { client, body, record, events, hubInk, hubRecord: () => hubRecord };
  }

  it("uploads even an empty erasure page before publishing its manifest", async () => {
    const f = fixture();
    await putPadRecord(f.client, kind, f.body, []);
    expect(f.events).toEqual(["ink", "record"]);
    expect(f.hubRecord()).toBe(f.body);
    expect(f.client.pingPadSync).not.toHaveBeenCalled();
  });

  it("keeps the old record when the ink transfer fails", async () => {
    const f = fixture();
    vi.mocked(f.client.putInkPage).mockRejectedValue(new Error("ink failed"));
    await expect(putPadRecord(f.client, kind, f.body, [])).rejects.toThrow("ink failed");
    expect(f.record).not.toHaveBeenCalled();
    expect(f.hubRecord()).toBeNull();
  });

  it("leaves only unreferenced ink if the later record PUT fails", async () => {
    const f = fixture();
    f.record.mockImplementation(async () => { f.events.push("record"); throw new Error("record failed"); });
    await expect(putPadRecord(f.client, kind, f.body, [])).rejects.toThrow("record failed");
    expect(f.events).toEqual(["ink", "record"]);
    expect(f.hubInk.has(113)).toBe(true);
    expect(f.hubRecord()).toBeNull();
  });

  it("blocks a manifest missing a page both locally and remotely", async () => {
    const f = fixture();
    store.rows.clear();
    await expect(putPadRecord(f.client, kind, f.body, [])).rejects.toThrow("missing");
    expect(f.record).not.toHaveBeenCalled();
  });

  it("accepts a page proven present by the snapshot", async () => {
    const f = fixture();
    store.rows.clear();
    f.hubInk.set(113, { kind, key: "book", page_id: 113, updated_at: 10, gz: "AQID" });
    await putPadRecord(f.client, kind, f.body, [...f.hubInk.values()]);
    expect(f.events).toEqual(["record"]);
  });

  it("stages a restore with the same newer sequence as its parent PUT", async () => {
    const f = fixture();
    f.body.sync_seq = 6;
    await putPadRecord(f.client, kind, f.body, []);
    expect(f.client.putInkPage).toHaveBeenCalledWith(expect.objectContaining({ sync_seq: 6 }));
    expect(f.record).toHaveBeenCalledWith("book", expect.objectContaining({ sync_seq: 6 }));
  });
});

it("checks scratch-board manifests before the parent record", async () => {
  store.rows.set("fnwb:book:note", [{ pageId: 2, updatedAt: 10, gz: new Uint8Array([1]) }]);
  const client = { putInkPage: vi.fn(async () => {}), putAnnotatePad: vi.fn(async () => ({})) } as unknown as LcClient;
  await putPadRecord(client, "annotate", {
    id: "book", footnote_boards: { note: { board: { inkPages: { v: 1, pageIds: [2] } }, pageCount: 2 } },
  } as unknown as AnnotatePadDto, []);
  expect(client.putInkPage).toHaveBeenCalledWith(expect.objectContaining({ key: "book/fn/note", page_id: 2 }));
  expect(client.putAnnotatePad).toHaveBeenCalledOnce();
});
