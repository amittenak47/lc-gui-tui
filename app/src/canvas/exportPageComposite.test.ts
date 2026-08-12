/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

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

  it("paints PDF canvas content into the export rect", async () => {
    const pageBounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const exportBounds = { minX: 10, minY: 10, maxX: 190, maxY: 90 };

    const pdfCanvas = document.createElement("canvas");
    pdfCanvas.className = "lc-pdf-canvas";
    pdfCanvas.width = 200;
    pdfCanvas.height = 100;

    const slot = document.createElement("div");
    slot.style.width = "200px";
    slot.style.height = "100px";
    slot.appendChild(pdfCanvas);

    const slotRect = {
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    slot.getBoundingClientRect = () => slotRect as DOMRect;
    pdfCanvas.getBoundingClientRect = () => slotRect as DOMRect;

    const drawImage = vi.fn();
    const exportCtx = { drawImage } as unknown as CanvasRenderingContext2D;

    await compositePageLayers(exportCtx, exportBounds, 1, {
      contentSlot: slot,
      marksSlot: null,
      pageBounds,
      paperColor: "#fff",
    });

    // Page pixels land under ink — source is the live PDF bitmap, not empty paper.
    expect(drawImage).toHaveBeenCalled();
    expect(drawImage.mock.calls[0]?.[0]).toBe(pdfCanvas);
    expect(pdfCanvas.width).toBeGreaterThan(0);
    expect(pdfCanvas.height).toBeGreaterThan(0);
  });

  it("keeps opaque theme fills and rejects empty paper fallback", () => {
    expect(resolveExportPaperColor("#abc", "")).toBe("#abc");
  });
});
