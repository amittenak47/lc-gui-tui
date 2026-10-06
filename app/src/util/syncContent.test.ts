// @vitest-environment node
import { gzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import golden from "./fixtures/sync-content-golden.json";
import { canonicalJson, hashBytes, MAX_PACKED_INK_BYTES, normalizeRecord, recordHash, validateInk, validatePackedInk } from "./syncContent";

beforeAll(async () => {
  const module = "node:crypto";
  const { webcrypto } = await import(module) as { webcrypto: Crypto };
  vi.stubGlobal("crypto", webcrypto);
});
afterAll(() => vi.unstubAllGlobals());

function packed(meta: unknown, payload = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(12 + json.length + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x436b6e69, true); view.setUint32(4, 1, true); view.setUint32(8, json.length, true);
  out.set(json, 12); out.set(payload, 12 + json.length);
  return out;
}

describe("cross-language content contract", () => {
  for (const fixture of golden.canonical) it(fixture.name, async () => {
    const text = canonicalJson(JSON.parse(fixture.input));
    expect(text).toBe(fixture.canonical);
    expect(await hashBytes(new TextEncoder().encode(text))).toBe(fixture.hash);
  });
  for (const fixture of golden.records) it(fixture.name, async () => {
    const input = JSON.parse(fixture.input);
    expect(canonicalJson(normalizeRecord(input))).toBe(fixture.canonical);
    expect(await recordHash(input)).toBe(fixture.hash);
  });
  it("keeps authored paper/source/nested hashes but excludes device view", async () => {
    const value = { id: "b", hash: "source", unknown: { rev: 7, hash: "nested" },
      board: { appState: { scrollX: 1, pdfSpread: true, linedPitch: 24 }, inkPages: { v: 1, pageIds: [113] } } };
    const hash = await recordHash(value);
    expect(await recordHash({ ...value, board: { ...value.board, appState: { ...value.board.appState, scrollX: 99, pdfSpread: false }, inkPages: { v: 1, pageIds: [1] } } })).toBe(hash);
    expect(await recordHash({ ...value, hash: "changed" })).not.toBe(hash);
    expect(await recordHash({ ...value, unknown: { ...value.unknown, rev: 8 } })).not.toBe(hash);
    expect(await recordHash({ ...value, board: { ...value.board, appState: { ...value.board.appState, linedPitch: 32 } } })).not.toBe(hash);
  });
  it("rejects non-JSON values rather than silently losing content", () => {
    for (const value of [NaN, Infinity, undefined, 1n, new Date(), { x: undefined }, [undefined], "\ud800", { ["\udfff"]: 1 }]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {}; cyclic.x = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
    const sparse = new Array(2);
    Object.assign(sparse, { custom: 1, another: 2 });
    expect(() => canonicalJson(sparse)).toThrow();
  });
  for (const fixture of golden.ink) it(`raw/gzip ${fixture.name}`, async () => {
    const raw = Uint8Array.from(atob(fixture.base64), char => char.charCodeAt(0));
    const result = await validateInk(raw);
    expect(result.wireHash).toBe(fixture.hash);
    expect(result.isEmpty).toBe(fixture.isEmpty);
    for (const level of [1, 9] as const) {
      const compressed = await validateInk(gzipSync(raw, { level, mtime: 100 }));
      expect(compressed.packed).toEqual(raw);
      expect(compressed.wireHash).toBe(result.wireHash);
    }
  });
  it("retains the wire layout tag in the page hash", async () => {
    const left = packed({ meta: [], layout: { w: 760, spread: true } });
    const right = packed({ meta: [], layout: { w: 760, spread: false } });
    expect((await validateInk(left)).wireHash).not.toBe((await validateInk(right)).wireHash);
  });
  it("rejects bad CRC, truncation, trailing bytes and concatenated gzip members", async () => {
    const raw = packed({ meta: [] });
    const good = gzipSync(raw);
    const bad = good.slice(); bad[bad.length - 8] ^= 1;
    await expect(validateInk(bad)).rejects.toThrow();
    const badSize = good.slice(); badSize[badSize.length - 4] ^= 1;
    await expect(validateInk(badSize)).rejects.toThrow();
    const headerCrc = new Uint8Array(good.length + 2);
    headerCrc.set(good.subarray(0, 10)); headerCrc[3] |= 2;
    headerCrc.set(good.subarray(10), 12);
    await expect(validateInk(headerCrc)).rejects.toThrow("header CRC");
    await expect(validateInk(good.subarray(0, good.length - 3))).rejects.toThrow();
    const trailing = new Uint8Array(good.length + 1); trailing.set(good);
    await expect(validateInk(trailing)).rejects.toThrow();
    const multiple = new Uint8Array(good.length * 2); multiple.set(good); multiple.set(good, good.length);
    await expect(validateInk(multiple)).rejects.toThrow();
  });
  it("validates kinds, counts and complete bounds before decoding allocation", () => {
    for (const op of [
      { k: "x", x0: 0, y0: 0, n: 1, xyN: 0, prN: 0, slN: 0 },
      { k: "d", x0: 0, y0: 0, n: 2, xyN: 0, prN: 0, slN: 0 },
      { k: "d", x0: 0, y0: 0, n: 2, xyN: 2, prN: 1, slN: 0 },
      { k: "e", x0: 0, y0: 0, n: 1, xyN: Number.MAX_SAFE_INTEGER, prN: 0, slN: 0 },
      { k: "d", x0: Infinity, y0: 0, n: 1, xyN: 0, prN: 0, slN: 0 },
    ]) expect(() => validatePackedInk(packed({ meta: [op] }))).toThrow();
    for (const layout of [{ w: 0, spread: false }, { w: 760, spread: 1 }]) {
      expect(() => validatePackedInk(packed({ meta: [], layout }))).toThrow();
    }
    expect(() => validatePackedInk(packed({ meta: [], raw: [{ kind: "erase", points: [{ x: null, y: 0 }] }] }))).toThrow();
    const raw = packed({ meta: [] });
    const trailing = new Uint8Array(raw.length + 1); trailing.set(raw);
    expect(() => validatePackedInk(trailing)).toThrow();
  });
  it("accepts the inclusive packed-asset limit and rejects over-limit expansion", async () => {
    const baseline = packed({ meta: [], future: "" }).length;
    const raw = packed({ meta: [], future: " ".repeat(MAX_PACKED_INK_BYTES - baseline) });
    expect(raw.length).toBe(MAX_PACKED_INK_BYTES);
    expect((await validateInk(raw)).isEmpty).toBe(true);
    const over = new Uint8Array(raw.length + 1); over.set(raw);
    await expect(validateInk(over)).rejects.toThrow("limit");
    await expect(validateInk(gzipSync(over, { level: 1 }))).rejects.toThrow("limit");
  }, 20_000);
});
