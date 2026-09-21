import { describe, expect, it } from "vitest";
import { documentAskFields, documentImageContext, hasDocumentCapture, livePadStillOpen, sameDocumentIdentity, sameDocumentView, type DocumentViewContext } from "./documentView";
const view: DocumentViewContext = { document_hash: "book", title: "Book", format: "pdf", pages: [3, 4], text: "visible words", revision: "ink1", viewport: { x: 0, y: 10, width: 800, height: 600 } };
describe("frozen document context", () => {
  it("retains the explicit text-only selection limitation when no image is attached", () => {
    const limitation = "Selection image unavailable. Answer only from selected text; do not infer unseen figures.";
    expect(documentAskFields(documentImageContext({ ...view, limitation }, false)).page_text).toContain(limitation);
  });
  it("retains visible pages and text independently of later navigation", () => {
    const stored = structuredClone(view);
    expect(documentAskFields(stored)).toMatchObject({ document_hash: "book", page: 3 });
    expect(documentAskFields(stored).page_text).toContain("3, 4");
    expect(sameDocumentView(view, { ...view, viewport: { ...view.viewport, y: 20 } })).toBe(false);
    expect(sameDocumentView(view, { ...view, revision: "ink2" })).toBe(false);
  });
  it("bounds text and states unavailable image limitations", () => {
    const fields = documentAskFields({ ...view, text: "x".repeat(15000), limitation: "Image unavailable" });
    expect(fields.page_text.length).toBeLessThan(12200);
    expect(fields.page_text).toContain("truncated");
    expect(fields.page_text).toContain("Image unavailable");
  });
  it("rejects a different pane even when camera and ink revisions match", () => {
    const left = { ...view, paneId: "left" };
    expect(sameDocumentView(left, { ...left, paneId: "right" })).toBe(false);
    expect(sameDocumentView(left, { ...left, paneId: undefined })).toBe(false);
    expect(sameDocumentView(left, structuredClone(left))).toBe(true);
  });
  it("rejects changed visible pages or extracted text during export", () => {
    expect(sameDocumentView(view, { ...view, pages: [4, 5] })).toBe(false);
    expect(sameDocumentView(view, { ...view, text: "newly loaded text" })).toBe(false);
    expect(sameDocumentView(view, { ...view, viewport: { height: 600, width: 800, y: 10, x: 0 } })).toBe(true);
  });
  it("allows a frozen selection after scrolling, but rejects another source or pane", () => {
    const seed = { ...view, paneId: "left" };
    const scrolled = { ...seed, viewport: { ...view.viewport, y: 500 }, revision: "ink2" };
    expect(sameDocumentIdentity(seed, scrolled)).toBe(true);
    expect(sameDocumentView(seed, scrolled)).toBe(false);
    expect(sameDocumentIdentity(seed, { ...seed, document_hash: "other-book" })).toBe(false);
    expect(sameDocumentIdentity(seed, { ...seed, paneId: "right" })).toBe(false);
  });
  it("treats a replaced handle and source record as the same pad", () => {
    const boardId = {};
    const started = { sourceHash: "book", boardId, paneId: "left" };
    const liveBoard = { instanceId: boardId, captureDocumentView: () => ({ paneId: "left" as const }) };
    expect(livePadStillOpen(started, { hash: "book" }, liveBoard)).toBe(true);
    expect(livePadStillOpen(started, { hash: "book" }, { ...liveBoard })).toBe(true);
    expect(livePadStillOpen(started, { hash: "other-book" }, liveBoard)).toBe(false);
    expect(livePadStillOpen(started, { hash: "book" }, { instanceId: {}, captureDocumentView: liveBoard.captureDocumentView })).toBe(false);
    expect(livePadStillOpen(started, { hash: "book" }, { instanceId: boardId, captureDocumentView: () => ({ paneId: "right" }) })).toBe(false);
    expect(livePadStillOpen(started, null, liveBoard)).toBe(false);
  });
  it("requires the selection's own PNG, not an unrelated photo or a removed capture", () => {
    const seed = { ...view, documentCaptureId: "selection-1" };
    const capture = { documentCaptureId: "selection-1", png: "selection-png" };
    expect(hasDocumentCapture(seed, [capture])).toBe(true);
    expect(hasDocumentCapture(seed, [{ png: "unrelated-photo" }])).toBe(false);
    expect(hasDocumentCapture(seed, [{ ...capture, documentCaptureId: "selection-2" }])).toBe(false);
    expect(hasDocumentCapture(seed, [{ ...capture, png: "" }])).toBe(false);
    expect(hasDocumentCapture(view, [capture])).toBe(false);
    const available = documentImageContext(seed, hasDocumentCapture(seed, [capture]));
    expect(documentAskFields(available).page_text).not.toContain("Image unavailable");
    const removed = documentImageContext(seed, hasDocumentCapture(seed, [{ png: "unrelated-photo" }]));
    expect(documentAskFields(removed).page_text).toContain("Image unavailable");
  });
  it("preserves an existing limitation with an image and reports missing text and image", () => {
    expect(documentImageContext({ ...view, limitation: "Some pages were omitted" }, true).limitation).toBe("Some pages were omitted");
    expect(documentImageContext({ ...view, text: " " }, false).limitation).toContain("no readable extracted text or image");
    expect(view.limitation).toBeUndefined();
  });
});
