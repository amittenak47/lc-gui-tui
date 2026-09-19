import { expect, it, vi } from "vitest";
import { askImages, freezeCoachAsk, type FrozenAsk } from "./coachAskPayload";
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
