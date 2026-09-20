import type { CoachProcessEvent } from "../api/types";

/** Ephemeral UI state owned by a panel, never part of the synced transcript. */
export interface ThinkingDisclosureState {
  sectionOpen?: boolean;
  steps: Record<string, boolean>;
}
export function newThinkingDisclosure(): ThinkingDisclosureState { return { steps: {} }; }
export function thinkingStepKey(event: CoachProcessEvent, index: number): string {
  return event.updateId ?? `${event.ts}-${index}-${event.label}`;
}
/** Stable across chunks, remounts and saved history; color is not a status. */
export function thinkingStepColor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return (hash >>> 0) % 5;
}
