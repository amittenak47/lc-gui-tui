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
export function askImages(photos: readonly { png: string }[], vision: boolean): string[] {
  return vision ? [...new Set(photos.map(photo => photo.png).filter(Boolean))] : [];
}
