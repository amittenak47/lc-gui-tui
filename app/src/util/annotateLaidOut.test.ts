/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  annotateHeightIsSettled,
  waitForAnnotateLaidOut,
  waitForPdfPageNode,
} from "./annotateLaidOut";

describe("annotateHeightIsSettled", () => {
  it("treats null and negatives as silence", () => {
    expect(annotateHeightIsSettled(null, true)).toBe(false);
    expect(annotateHeightIsSettled(Number.NaN, true)).toBe(false);
    expect(annotateHeightIsSettled(-1, true)).toBe(false);
  });

  it("lets an empty note settle at zero", () => {
    expect(annotateHeightIsSettled(0, true)).toBe(true);
  });

  it("does not treat zero as laid out when the file has content", () => {
    expect(annotateHeightIsSettled(0, false)).toBe(false);
    expect(annotateHeightIsSettled(9000, false)).toBe(true);
  });
});

describe("waitForAnnotateLaidOut", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not resolve on a sticky zero while the file has content", async () => {
    expect(await waitForAnnotateLaidOut(() => 0, 80, false)).toBe(false);
  });

  it("resolves once a real height is stable", async () => {
    let height: number | null = 0;
    const pending = waitForAnnotateLaidOut(() => height, 400, false);
    height = 9000;
    expect(await pending).toBe(true);
  });

  it("resolves on elapsed stability even when polls are sparse", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms) => {
      return realSetTimeout(handler as TimerHandler, Math.max(Number(ms) || 0, 200));
    });
    expect(await waitForAnnotateLaidOut(() => 9000, 2000, false)).toBe(true);
  });

  it("stops waiting when the reader reports a hard failure", async () => {
    const t0 = Date.now();
    expect(
      await waitForAnnotateLaidOut(
        () => null,
        4000,
        false,
        () => "this PDF could not be opened",
      ),
    ).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("resets the deadline while height is still growing", async () => {
    let height = 1000;
    const pending = waitForAnnotateLaidOut(() => height, 300, false);
    globalThis.setTimeout(() => {
      height = 4000;
    }, 80);
    globalThis.setTimeout(() => {
      height = 8000;
    }, 160);
    expect(await pending).toBe(true);
  });
});

describe("waitForPdfPageNode", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("resolves once the session page div exists", async () => {
    const pending = waitForPdfPageNode(47, 400);
    const node = document.createElement("div");
    node.className = "lc-pdf-page";
    node.dataset.pdfPage = "47";
    document.body.append(node);
    expect(await pending).toBe(true);
  });

  it("does not treat page 1 as the session page", async () => {
    const first = document.createElement("div");
    first.className = "lc-pdf-page";
    first.dataset.pdfPage = "1";
    document.body.append(first);
    expect(await waitForPdfPageNode(47, 80)).toBe(false);
  });
});
