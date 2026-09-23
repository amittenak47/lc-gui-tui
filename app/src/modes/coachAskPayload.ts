import type { LcClient } from "../api/client";
export type CoachAskPayload = Parameters<LcClient["ask"]>[1] & { question: string };
export interface FrozenAsk { userMessageId: string; askPayload?: CoachAskPayload }
/** Persist the wire request once. Retry must not repack newer transcript/context. */
export async function freezeCoachAsk<T extends FrozenAsk>(item: T | undefined, build: () => CoachAskPayload,
  save: (id: string, item: T) => Promise<void>): Promise<CoachAskPayload> {
  if (item?.askPayload) return structuredClone(item.askPayload);
  const payload = structuredClone(build());
  if (item) { item.askPayload = payload; await save(item.userMessageId, item); }
  return structuredClone(payload);
}
export function askImages(photos: readonly { png: string; sendToModel?: boolean }[], vision: boolean): string[] {
  if (!vision) return [];
  return [...new Set(photos.filter((photo) => photo.sendToModel !== false).map((photo) => photo.png).filter(Boolean))];
}

/**
 * A boxed region is what the student pointed at. Labels and captions inside
 * it do not replace the picture. A text highlight already is the words, so
 * its PNG is a second copy of those glyphs.
 */
export function selectionImageForModel(selection: {
  text?: string;
  excerpt?: string;
  anchor?: { kind?: string };
}): boolean {
  const words = (selection.text || selection.excerpt || "").trim();
  if (!words) return true;
  return selection.anchor?.kind === "region";
}
