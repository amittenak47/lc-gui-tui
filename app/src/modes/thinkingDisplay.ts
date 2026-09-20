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
