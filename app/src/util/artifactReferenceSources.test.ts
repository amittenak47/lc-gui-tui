// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { captureLibraryReference, referenceSnapshot } from "./artifactReferenceSources";
import { parseArtifactSourceReference, REFERENCE_TEXT_LIMIT } from "./artifactReference";
const mocks = vi.hoisted(() => ({ get: vi.fn(), bytes: vi.fn(), page: vi.fn(), destroy: vi.fn(), borrow: vi.fn() }));
vi.mock("./annotateStore", () => ({ getAnnotateDoc: mocks.get, annotateDocLabel: () => "Library file" }));
vi.mock("./docBytes", () => ({ getDocBytes: mocks.bytes }));
vi.mock("./docExtract", () => ({ htmlToText: (s: string) => s.replace(/<[^>]+>/g, "") }));
vi.mock("../modes/pdfOpenDocs", () => ({ borrowPdfDocument: mocks.borrow }));
vi.mock("../modes/PdfDocument", () => ({ pdfWorker: () => ({}), pdfJsDataUrls: () => ({}), loadPdfJs: async () => ({
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1000, getPage: mocks.page }), destroy: mocks.destroy }),
}) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ id: "file", hash: "hash", updatedAt: 5, source: Array.from({ length: 300 }, (_, n) => `line ${n + 1}`).join("\n"), docType: "code" });
  mocks.bytes.mockResolvedValue(new ArrayBuffer(8));
  mocks.borrow.mockReturnValue(null);
});
it("captures only the requested text section, with stable source provenance", async () => {
  const captured = await captureLibraryReference("file", 2);
  expect(captured.text.split("\n")).toHaveLength(120);
  expect(captured.text.startsWith("line 121\n")).toBe(true);
  expect(captured.text.endsWith("line 240")).toBe(true);
  expect(parseArtifactSourceReference(captured.reference)).toMatchObject({ parent: { kind: "annotate", id: "file" }, revision: "hash:5" });
  expect(mocks.bytes).not.toHaveBeenCalled();
});
it("bounds very long lines and records truncation", async () => {
  mocks.get.mockResolvedValue({ hash: "hash", updatedAt: 5, source: "x".repeat(30000), docType: "markdown" });
  const captured = await captureLibraryReference("file", 1);
  expect(captured.text).toHaveLength(REFERENCE_TEXT_LIMIT);
  expect(captured.reference.truncated).toBe(true);
  expect(referenceSnapshot(captured, { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } }).sourceReference).toEqual(captured.reference);
});
it("rejects missing/trash sources, invalid pages and out-of-range sections", async () => {
  await expect(captureLibraryReference("file", 0)).rejects.toThrow("starting at 1");
  await expect(captureLibraryReference("file", 4)).rejects.toThrow("3 sections");
  mocks.get.mockResolvedValue(null);
  await expect(captureLibraryReference("file", 1)).rejects.toThrow("unavailable");
  mocks.get.mockResolvedValue({ deletedAt: 10 });
  await expect(captureLibraryReference("file", 1)).rejects.toThrow("Trash");
});
it("extracts and renders one PDF page, then releases its loading task", async () => {
  mocks.get.mockResolvedValue({ hash: "hash", updatedAt: 5, docType: "pdf" });
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  mocks.page.mockResolvedValue({ getTextContent: async () => ({ items: [{ str: "selected page" }] }),
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,YQ==");
  try {
    const captured = await captureLibraryReference("file", 750);
    expect(mocks.page).toHaveBeenCalledTimes(1);
    expect(mocks.page).toHaveBeenCalledWith(750);
    expect(render).toHaveBeenCalledTimes(1);
    expect(captured.text).toBe("selected page");
    expect(captured.reference.image).toBe("data:image/png;base64,YQ==");
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); }
});
it("releases PDF resources on extraction failure", async () => {
  mocks.get.mockResolvedValue({ hash: "hash", updatedAt: 5, docType: "pdf" });
  mocks.page.mockRejectedValue(new Error("damaged page"));
  await expect(captureLibraryReference("file", 2)).rejects.toThrow("damaged page");
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it("rejects invalid or oversized capture metadata", () => {
  const base = { v: 1, parent: { kind: "problem", id: "d/1" }, revision: "r", label: "P", locator: "Page 1", capturedAt: 1, truncated: false };
  expect(() => parseArtifactSourceReference({ ...base, image: "https://example.com/image.png" })).toThrow();
  expect(() => parseArtifactSourceReference({ ...base, image: "data:image/png;base64," + "a".repeat(1500000) })).toThrow();
  expect(() => parseArtifactSourceReference({ ...base, parent: { kind: "file", id: "disk" } })).toThrow();
});
