import { expect, it, vi } from "vitest";
import { askImages, freezeCoachAsk, type FrozenAsk } from "./coachAskPayload";
import { documentAskFields, documentImageContext, hasDocumentCapture, type DocumentViewContext } from "./documentView";
it("sends identical stored document fields/images on retry after navigation", async () => {
  const item: FrozenAsk = { userMessageId: "a" }; const save = vi.fn(async () => {});
  const build = vi.fn(() => ({ surface: "annotate" as const, question: "Original history + question", document_hash: "pdf-A", page: 3, page_text: "pages 3, 4", highlight: "quote", images: ["original-png"] }));
  const first = await freezeCoachAsk(item, build, save);
  const retry = await freezeCoachAsk(structuredClone(item), () => ({ surface: "annotate", question: "different", document_hash: "epub-B", page: 1 }), save);
  expect(retry).toEqual(first); expect(save).toHaveBeenCalledTimes(1);
  expect(retry.images).toEqual(["original-png"]);
});
it("omits images for text-only models and sends duplicate attachments only once", () => {
  expect(askImages([{ png: "photo" }, { png: "photo" }, { png: "view" }], true)).toEqual(["photo", "view"]);
  expect(askImages([{ png: "photo" }], false)).toEqual([]);
});
it("isolates stored payloads from callers mutating the first send or a retry", async () => {
  const item: FrozenAsk = { userMessageId: "immutable" };
  const first = await freezeCoachAsk(item, () => ({ surface: "annotate", question: "Original", images: ["original-png"] }), async () => {});
  first.question = "Mutated";
  first.images!.push("extra-png");
  const retry = await freezeCoachAsk(item, () => ({ surface: "annotate", question: "Wrong" }), async () => {});
  expect(retry).toEqual({ surface: "annotate", question: "Original", images: ["original-png"] });
  retry.images!.length = 0;
  expect(item.askPayload?.images).toEqual(["original-png"]);
});
it("freezes a selection image with matching document fields without a false missing-image warning", async () => {
  const view: DocumentViewContext = {
    paneId: "left", document_hash: "pdf-A", title: "Original document", format: "pdf",
    pages: [3], text: "Selected equation", revision: "ink1", documentCaptureId: "selection-1",
    viewport: { x: 0, y: 30, width: 800, height: 600 },
  };
  const photos = [{ png: "selection-png", documentCaptureId: "selection-1" }, { png: "unrelated-photo" }];
  const item: FrozenAsk = { userMessageId: "selection" };
  const first = await freezeCoachAsk(item, () => ({
    surface: "annotate", question: "Explain this", highlight: view.text,
    ...documentAskFields(documentImageContext(view, hasDocumentCapture(view, photos))),
    images: askImages(photos, true),
  }), async () => {});
  view.document_hash = "pdf-B";
  view.pages[0] = 9;
  photos[0].png = "new-image";
  const retry = await freezeCoachAsk(item, () => ({ surface: "annotate", question: "Wrong" }), async () => {});
  expect(retry).toEqual(first);
  expect(retry).toMatchObject({ document_hash: "pdf-A", page: 3, highlight: "Selected equation", images: ["selection-png", "unrelated-photo"] });
  expect(retry.page_text).not.toContain("Image unavailable");
});
