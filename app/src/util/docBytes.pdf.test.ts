/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { pdfByteReport } from "./docBytes";

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("pdfByteReport", () => {
  it("calls an empty copy empty", () => {
    expect(pdfByteReport(new ArrayBuffer(0))).toEqual({
      whole: false,
      detail: "the copy is empty",
    });
  });

  it("names a file that is not a PDF at all", () => {
    const report = pdfByteReport(bytesOf("<!doctype html><html>nope</html>"));
    expect(report.whole).toBe(false);
    expect(report.detail).toContain("does not begin with %PDF");
  });

  it("names a truncated PDF — header, no trailer", () => {
    const report = pdfByteReport(bytesOf(`%PDF-1.7\n${"x".repeat(9000)}`));
    expect(report.whole).toBe(false);
    expect(report.detail).toContain("truncated");
    expect(report.detail).toContain("%PDF-1.7");
  });

  it("passes a whole PDF, so a later failure is not blamed on the file", () => {
    const report = pdfByteReport(bytesOf(`%PDF-1.4\n${"x".repeat(2000)}\n%%EOF\n`));
    expect(report.whole).toBe(true);
    expect(report.detail).toContain("%%EOF present");
  });

  it("does not mistake an early %%EOF for a whole file", () => {
    // A real PDF's %%EOF is at the end; one buried megabytes back means the
    // tail after it never arrived.
    const report = pdfByteReport(bytesOf(`%PDF-1.4\n%%EOF\n${"x".repeat(20000)}`));
    expect(report.whole).toBe(false);
  });
});

describe("lengthFromHash", () => {
  it("reads back the length hashBytes encoded", async () => {
    const { hashBytes, lengthFromHash } = await import("./docBytes");
    const bytes = new Uint8Array(859).buffer;
    expect(lengthFromHash(hashBytes(bytes))).toBe(859);
  });

  it("leaves a key this build did not write alone", async () => {
    const { lengthFromHash } = await import("./docBytes");
    expect(lengthFromHash("sha256:abc")).toBeNull();
    expect(lengthFromHash("binabc")).toBeNull();
  });
});

describe("pdfByteReport names what the bytes really are", () => {
  it("calls out a JSON body answered in place of a document", () => {
    const report = pdfByteReport(bytesOf('{"error":"no bytes for this document"}'));
    expect(report.whole).toBe(false);
    expect(report.detail).toContain("it is JSON");
    expect(report.detail).toContain("no bytes for this document");
  });

  it("calls out an HTML error page", () => {
    const report = pdfByteReport(bytesOf("<!doctype html><title>502</title>"));
    expect(report.detail).toContain("HTML page");
  });

  it("calls out a ZIP opened as a PDF", () => {
    const report = pdfByteReport(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]).buffer);
    expect(report.detail).toContain("ZIP");
  });
});
