import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeInkOps, encodeInkOps, unpackEncodedInk, type EncodedInk } from "../canvas/inkCodec";
import { NO_PRESSURE, type InkDrawOp } from "../canvas/rasterInk";
import type { InkPageRecord } from "./inkPageStore";

const rows = vi.hoisted(() => new Map<string, InkPageRecord>());
vi.mock("./inkPageStore", () => ({
  listInkDocKeys: async (prefix: string) => [...new Set([...rows.values()].map((r) => r.docKey))].filter((k) => k.startsWith(prefix)),
  getInkPageRecords: async (docKey: string) => [...rows.values()].filter((r) => r.docKey === docKey),
  encodedFromRecord: async (row: InkPageRecord) => row.inkC ?? null,
  inkPageKey: (docKey: string, pageId: number) => `${docKey}#${pageId}`,
}));
vi.mock("./idb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./idb")>()),
  STORE_INK_PAGES: "ink",
  withStore: async (_name: string, _mode: string, fn: (store: unknown) => void) => {
    fn({
      get: (key: string) => {
        const request: { result?: unknown; onsuccess?: () => void } = {};
        queueMicrotask(() => { request.result = rows.get(key); request.onsuccess?.(); });
        return request;
      },
      put: (value: InkPageRecord, key: string) => { rows.set(key, value); },
    });
    await new Promise((r) => setTimeout(r, 0));
  },
}));

const { auditInkDuplicates } = await import("./inkDuplicates");

const stroke = (y: number, id: number): InkDrawOp => ({
  kind: "draw", color: "#111", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false, id, seq: id,
  points: [{ x: 10, y, pressure: NO_PRESSURE }, { x: 30, y, pressure: NO_PRESSURE }],
});

beforeEach(() => {
  rows.clear();
  const encoded: EncodedInk = encodeInkOps([stroke(10, 1), stroke(10, 2), stroke(10, 3), stroke(40, 4)]);
  encoded.layout = { w: 642, spread: false };
  rows.set("md:book#15", { v: 1, docKey: "md:book", pageId: 15, inkC: encoded, dirty: false, updatedAt: 5 });
  rows.set("md:book#16", { v: 1, docKey: "md:book", pageId: 16, inkC: encodeInkOps([stroke(70, 9)]), dirty: false, updatedAt: 5 });
});

describe("auditInkDuplicates", () => {
  it("counts copies without changing anything", async () => {
    const report = await auditInkDuplicates({ remove: false });
    expect(report).toMatchObject({ books: 1, pages: 1, strokes: 5, duplicates: 2 });
    expect(rows.get("md:book#15")!.updatedAt).toBe(5);
  });

  it("keeps one of each, keeps the layout tag, and marks the page to sync", async () => {
    await auditInkDuplicates({ remove: true });
    const row = rows.get("md:book#15")!;
    expect(row.dirty).toBe(true);
    expect(row.updatedAt).toBeGreaterThan(5);
    const { bytesFromMaybeGzip } = await import("./gzip");
    const encoded = unpackEncodedInk(await bytesFromMaybeGzip(row.gz!))!;
    expect(decodeInkOps(encoded)).toHaveLength(2);
    expect(encoded.layout).toEqual({ w: 642, spread: false });
    expect(rows.get("md:book#16")!.updatedAt).toBe(5);
  });
});
