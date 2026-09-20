import type { CoachProcessEvent } from "../api/types";

/** Streaming snapshots replace one row; ordinary stages/tools still append. */
export function mergeProcessEvent(events: CoachProcessEvent[], next: CoachProcessEvent): CoachProcessEvent[] {
  if (!next.updateId) return [...events, next];
  const index = events.findIndex(event => event.updateId === next.updateId);
  if (!next.detail?.trim()) return events.filter(event => event.updateId !== next.updateId);
  if (index < 0) return [...events, next];
  const result = [...events];
  result[index] = { ...next, ts: events[index]!.ts };
  return result;
}
