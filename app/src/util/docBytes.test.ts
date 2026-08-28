/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import {
  bytesFromStoredValue,
  formatDocStoreReport,
  readBlobBytes,
  type DocStoreReport,
} from "./docBytes";

function report(over: Partial<DocStoreReport> = {}): DocStoreReport {
  return {
    db: "whiteboard.docs",
    version: 7,
    stores: [
      { name: "bytes", rows: 0 },
      { name: "content", rows: 5 },
      { name: "ink_pages", rows: 2 },
      { name: "note_links", rows: 3 },
      { name: "pad_sync_queue", rows: 9 },
      { name: "snapshots", rows: 9 },
    ],
    writeFailure: null,
    rows: 0,
    bytes: 0,
    wanted: 1,
    missing: 1,
    missingNames: [
      "Industry-Coding-Skills-Evaluation-Framework-CodeSignal-Skills-Evaluation-Lab-Short.pdf",
    ],
    ...over,
  };
}

describe("formatDocStoreReport", () => {
  it("puts the filename on its own line instead of inside the paragraph", () => {
    const text = formatDocStoreReport(report());
    expect(text).toBe(
      [
        "whiteboard.docs v7",
        "Document copies: 0 (0 MB)",
        "Other stores: content 5, ink_pages 2, note_links 3, pad_sync_queue 9, snapshots 9",
        "1 of 1 library document has no stored copy.",
        "Industry-Coding-Skills-Evaluation-Framework-CodeSignal-Skills-Evaluation-Lab-Short.pdf",
        "A 64 KB test write saved and read back correctly, so saving works.",
        "Saving works, so these arrived by sync without their bytes — pick each one from Files once to restore it.",
      ].join("\n"),
    );
  });

  it("says have when more than one copy is missing", () => {
    const text = formatDocStoreReport(
      report({
        wanted: 3,
        missing: 2,
        missingNames: ["a.pdf", "b.pdf"],
      }),
    );
    expect(text).toContain("2 of 3 library documents have no stored copy.");
    expect(text).toContain("a.pdf\nb.pdf");
  });
});

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
