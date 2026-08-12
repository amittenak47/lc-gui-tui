/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { compositePageLayers, resolveExportPaperColor } from "./exportPageComposite";

describe("resolveExportPaperColor", () => {
  it("replaces transparent with paper", () => {
    expect(resolveExportPaperColor("transparent", "#f5f0e8")).toBe("#f5f0e8");
  });

  it("replaces missing / null with paper", () => {
    expect(resolveExportPaperColor(null, "#111")).toBe("#111");
    expect(resolveExportPaperColor(undefined, "#111")).toBe("#111");
  });

  it("keeps opaque theme fills", () => {
    expect(resolveExportPaperColor("#0a0a0b", "#fff")).toBe("#0a0a0b");
  });

  it("falls back when paper is empty", () => {
    expect(resolveExportPaperColor("transparent", "")).toBe("#ffffff");
  });
});

describe("compositePageLayers", () => {
  it("no-ops without page bounds", async () => {
    await expect(
      compositePageLayers(
        {} as CanvasRenderingContext2D,
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        1,
        {
          contentSlot: null,
          marksSlot: null,
          pageBounds: null,
          paperColor: "#fff",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps opaque theme fills and rejects empty paper fallback", () => {
    expect(resolveExportPaperColor("#abc", "")).toBe("#abc");
  });
});
