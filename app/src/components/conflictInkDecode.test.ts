import { expect, it, vi } from "vitest";
import { decodeConflictInkPages, type ConflictInkDecodeCache } from "./conflictInkLayout";
import { gunzipUnpackInk } from "../canvas/inkArchiveClient";
import { decodeInkOpsAsync } from "../canvas/inkCodec";
import type { InkPageDto } from "../api/client";

vi.mock("../canvas/inkArchiveClient", () => ({gunzipUnpackInk:vi.fn(async () => ({v:2,ops:[]}))}));
vi.mock("../canvas/inkCodec", () => ({decodeInkOpsAsync:vi.fn(async () => [{kind:"erase",radius:2,points:[{x:1,y:1,pressure:1}]}])}));
const row = (page: number, gz: string): InkPageDto => ({kind:"annotate",key:"book",page_id:page,gz,updated_at:1});

it("reuses unchanged ink across replicas and when loading another entry", async () => {
  const cache: ConflictInkDecodeCache = new Map();
  const before = vi.mocked(gunzipUnpackInk).mock.calls.length;
  const local = await decodeConflictInkPages([row(1,"AQ==")],cache);
  const remote = await decodeConflictInkPages([row(1,"AQ==")],cache);
  const next = await decodeConflictInkPages([row(1,"AQ=="),row(2,"Ag==")],cache);
  expect(gunzipUnpackInk).toHaveBeenCalledTimes(before+2);
  expect(remote[0].ops).toBe(local[0].ops);
  expect(next[0].ops).toBe(local[0].ops);
  expect(next.map(shard=>shard.pageId)).toEqual([1,2]);
});

it("stops obsolete decoding between shards", async () => {
  const controller = new AbortController();
  vi.mocked(decodeInkOpsAsync).mockImplementationOnce(async () => { controller.abort(); return []; });
  const before = vi.mocked(gunzipUnpackInk).mock.calls.length;
  expect(await decodeConflictInkPages([row(1,"AQ=="),row(2,"Ag==")],new Map(),controller.signal)).toEqual([]);
  expect(gunzipUnpackInk).toHaveBeenCalledTimes(before+1);
});
