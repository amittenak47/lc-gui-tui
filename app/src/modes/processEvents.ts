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

const LIST_ITEM = /^(?:\d+[.)]|[-*])\s/;

function looksLikeEmbeddedListItem(detail: string | undefined): boolean {
  const line = (detail ?? "").trimStart().split("\n")[0]?.trim() ?? "";
  return LIST_ITEM.test(line);
}

/** Keep `1.` / `-` lines inside the thought that introduced them. */
export function coalesceReasonListItems(events: CoachProcessEvent[]): CoachProcessEvent[] {
  const out: CoachProcessEvent[] = [];
  for (const event of events) {
    const prev = out.at(-1);
    if (
      event.kind === "stage" &&
      event.label === "reason" &&
      prev?.kind === "stage" &&
      prev.label === "reason" &&
      looksLikeEmbeddedListItem(event.detail)
    ) {
      out[out.length - 1] = {
        ...prev,
        detail: [prev.detail, event.detail].filter((part) => part?.trim()).join("\n"),
      };
      continue;
    }
    out.push(event);
  }
  return out;
}
