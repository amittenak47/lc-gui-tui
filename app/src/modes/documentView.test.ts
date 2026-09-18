import { describe, expect, it } from "vitest";
import { documentAskFields, sameDocumentView, type DocumentViewContext } from "./documentView";
const view: DocumentViewContext = { document_hash: "book", title: "Book", format: "pdf", pages: [3, 4], text: "visible words", revision: "ink1", viewport: { x: 0, y: 10, width: 800, height: 600 } };
describe("frozen document context", () => {
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
});
