/**
 * The sniff is what matters here.
 *
 * A sidecar is a file a writer keeps, renames, mails to themselves and opens on
 * another device — possibly one whose browser could not compress it in the
 * first place. Deciding by extension would fail all four; deciding by the first
 * two bytes fails none of them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { canGzip, gzipText, isGzip, textFromMaybeGzip } from "./gzip";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isGzip", () => {
  it("recognises the magic number", () => {
    expect(isGzip(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe(true);
  });

  it("does not mistake JSON for it", () => {
    expect(isGzip(new TextEncoder().encode('{"v":1}'))).toBe(false);
  });

  it("survives an empty or one-byte file", () => {
    expect(isGzip(new Uint8Array([]))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
  });
});

describe("round trip", () => {
  it("brings the text back exactly", async () => {
    const text = JSON.stringify({ v: 1, points: Array.from({ length: 500 }, (_, i) => i) });
    expect(await textFromMaybeGzip(await gzipText(text))).toBe(text);
  });

  it("reads an uncompressed file unchanged", async () => {
    // A sidecar written by a build without CompressionStream, or one a writer
    // gunzipped by hand. Neither should be a dead end.
    const text = '{"v":1,"sourceName":"notes.md"}';
    expect(await textFromMaybeGzip(new TextEncoder().encode(text))).toBe(text);
  });

  it("survives text that is not ASCII", async () => {
    const text = "“curly quotes”, é, 日本語, 🖋";
    expect(await textFromMaybeGzip(await gzipText(text))).toBe(text);
  });

  it("actually compresses redundant JSON", async () => {
    // Ink JSON is the same six field names tens of thousands of times over,
    // which is the entire reason gzip is worth reaching for here.
    const text = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({
        x: 640.19 + i,
        y: 312.41 + i,
        pressure: 0.4235294117647059,
        slowness: 0.5137254901960784,
      })),
    );
    const compressed = await gzipText(text);
    if (!canGzip()) return; // nothing to assert where the platform cannot
    expect(compressed.byteLength).toBeLessThan(text.length * 0.2);
  });
});

describe("without CompressionStream", () => {
  it("hands back plain UTF-8 rather than failing", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const bytes = await gzipText("hello");
    expect(isGzip(bytes)).toBe(false);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("says so plainly when asked to read a compressed file it cannot", async () => {
    const compressed = await gzipText(JSON.stringify({ v: 1 }));
    if (!isGzip(compressed)) return; // platform never compressed it
    vi.stubGlobal("DecompressionStream", undefined);
    await expect(textFromMaybeGzip(compressed)).rejects.toThrow(/compressed/);
  });
});
