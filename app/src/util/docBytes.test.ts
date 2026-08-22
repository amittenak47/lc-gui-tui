/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { bytesFromStoredValue, readBlobBytes } from "./docBytes";

describe("bytesFromStoredValue", () => {
  it("returns a non-empty ArrayBuffer as-is", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    expect(await bytesFromStoredValue(bytes)).toBe(bytes);
  });

  it("treats an empty buffer as missing", async () => {
    expect(await bytesFromStoredValue(new ArrayBuffer(0))).toBeNull();
    expect(await bytesFromStoredValue(new Blob([]))).toBeNull();
    expect(await bytesFromStoredValue(null)).toBeNull();
  });

  it("copies a typed-array view", async () => {
    const raw = new Uint8Array([0, 9, 8, 0]);
    const view = raw.subarray(1, 3);
    const got = await bytesFromStoredValue(view);
    expect(got).not.toBeNull();
    expect([...new Uint8Array(got!)]).toEqual([9, 8]);
  });

  it("reads a Blob", async () => {
    const blob = new Blob([new Uint8Array([4, 5])]);
    const got = await bytesFromStoredValue(blob);
    expect([...new Uint8Array(got!)]).toEqual([4, 5]);
  });

  it("falls back to FileReader when arrayBuffer throws", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])]);
    Object.defineProperty(blob, "arrayBuffer", {
      configurable: true,
      value: () => Promise.reject(new Error("detached")),
    });
    const got = await bytesFromStoredValue(blob);
    expect([...new Uint8Array(got!)]).toEqual([7, 8, 9]);
  });
});

describe("readBlobBytes", () => {
  it("retries via FileReader when arrayBuffer returns fewer bytes than the Blob", async () => {
    const payload = new Uint8Array([7, 8, 9, 10, 11]);
    const blob = new Blob([payload]);
    Object.defineProperty(blob, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([7, 8]).buffer,
    });
    const got = await readBlobBytes(blob);
    expect([...new Uint8Array(got)]).toEqual([7, 8, 9, 10, 11]);
  });

  it("uses FileReader when arrayBuffer is missing", async () => {
    const blob = new Blob([new Uint8Array([1, 4, 9])]);
    Object.defineProperty(blob, "arrayBuffer", { configurable: true, value: undefined });
    const got = await readBlobBytes(blob);
    expect([...new Uint8Array(got)]).toEqual([1, 4, 9]);
  });
});
