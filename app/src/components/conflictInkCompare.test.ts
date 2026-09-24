import { expect, it } from "vitest";
import { compareConflictInk } from "./conflictInkCompare";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { gzipBytes } from "../util/gzip";
import { bytesToB64 } from "../api/nativeHttp";
import type { InkPageDto } from "../api/client";

async function row(x: number, clock = 1): Promise<InkPageDto> {
  const gz = await gzipBytes(packEncodedInk(encodeInkOps([{kind:"erase",radius:2,points:[{x,y:40,pressure:1}]}])));
  gz[4] = clock; // Different gzip header; identical decompressed strokes.
  return {kind:"annotate",key:"book",page_id:50,updated_at:clock,gz:bytesToB64(gz)};
}

it("compares stroke content despite different clocks and gzip headers", async () => {
  expect(await compareConflictInk(await row(20), await row(20,2))).toBe(true);
});
it("keeps even a one-pixel handwriting difference visible", async () => {
  expect(await compareConflictInk(await row(20), await row(21,2))).toBe(false);
});
it("does not label missing or unreadable handwriting as identical", async () => {
  const valid = await row(20);
  expect(await compareConflictInk(valid, undefined)).toBeNull();
  expect(await compareConflictInk(valid, {...valid,gz:"unreadable"})).toBeNull();
});
it("joins the preview's decoded ink without allocating another copy", async () => {
  const local = {...await row(20),gz:"already-decoding-local"};
  const server = {...local,gz:"already-decoding-server"};
  const cache = new Map([[local.gz,Promise.resolve([])],[server.gz,Promise.resolve([])]]);
  expect(await compareConflictInk(local,server,cache)).toBe(true);
});
