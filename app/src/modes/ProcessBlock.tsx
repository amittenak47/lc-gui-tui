import { useEffect, useState } from "react";

import { STAGE_LABELS, type CoachProcessEvent } from "../api/types";

export const DOC_TOOL_LABELS: Record<string, string> = {
  query_document_vectors: "searching the book",
  get_document_section: "opening a section",
  lookup_reference: "checking a citation",
  get_current_page: "reading this page",
  get_highlight: "re-reading the highlight",
  list_document_marks: "listing marks",
  save_annotation: "pinning a tab",
  search_web: "searching the web",
};

export function reasonTitle(detail: string | undefined): string {
  const line = (detail ?? "").split("\n")[0]?.trim() ?? "";
  const stripped = line.replace(/^#+\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
  const clause = stripped.split(/[.!?:]/)[0]?.trim() || stripped;
  if (!clause) return "Thinking";
  return clause.length > 72 ? `${clause.slice(0, 71)}…` : clause;
}

/** CoT chunks — full fold text, not the process step list. */
export function isReasoningEvent(event: CoachProcessEvent): boolean {
  return event.kind === "reasoning" || event.label === "reasoning";
}

/**
 * Full chain-of-thought from process events, for turns that never stored
 * `message.reasoning` (older pads, or a daemon that only emitted `reason` stages).
 *
 * Prefer the uncut `reasoning` event when both exist — the chopped `reason`
 * steps are the same text again.
 */
export function reasoningTextFromEvents(events: readonly CoachProcessEvent[]): string {
  return (
    events.find((event) => event.kind === "reasoning" || event.label === "reasoning")
      ?.detail?.trim() ?? ""
  );
}

/** Prefer the stored fold; fall back to CoT that only arrived as process events. */
export function reasoningBodyForTurn(
  stored: string | undefined,
  events: readonly CoachProcessEvent[] | undefined,
): string {
  const fromStore = stored?.trim() ?? "";
  if (fromStore) return fromStore;
  return events?.length ? reasoningTextFromEvents(events) : "";
}

/** One process line. Unknown stage names fall back to the daemon's own text. */
export function processLine(event: CoachProcessEvent | undefined): string {
  if (!event) return "Working…";
  if (event.kind === "tool") {
    const named = DOC_TOOL_LABELS[event.label];
    if (named) {
      if (event.status === "rejected") return `dropped ${named}`;
      if (event.status === "proposed") return `asked for ${named}`;
      return named;
    }
    const verb =
      event.status === "rejected"
        ? "dropped"
        : event.status === "accepted"
          ? "drew"
          : "asked for";
    return [`${verb} ${event.label}`, event.detail].filter(Boolean).join(" — ");
  }
  if (event.label === "reason") return reasonTitle(event.detail);
  if (event.label === "prefetch") return STAGE_LABELS.prefetch ?? "Looking up earlier pages";
  return STAGE_LABELS[event.label] ?? event.detail ?? event.label;
}

function eventKey(event: CoachProcessEvent, index: number): string {
  return `${event.ts}-${index}-${event.label}`;
}

/**
 * What the coach did, one line per stage or tool call.
 *
 * Each step is tappable: the step's `detail` opens inline. `reason` stages
 * stay here as Thinking. The uncut chain-of-thought is the Reasoning fold.
 */
export function ProcessBlock({
  events,
  running,
}: {
  events: CoachProcessEvent[];
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [shownCount, setShownCount] = useState(0);
  const shown = events.filter(
    (event) => event.label !== "done" && !isReasoningEvent(event),
  );
  const expanded = open;
  useEffect(() => {
    if (running) {
      setShownCount(shown.length);
      return;
    }
    if (shownCount >= shown.length) {
      setShownCount(shown.length);
      return;
    }
    const id = window.setTimeout(() => {
      setShownCount((current) => Math.min(shown.length, current + 1));
    }, 60);
    return () => window.clearTimeout(id);
  }, [running, shown.length, shownCount]);
  const visible = shown.slice(0, running ? shown.length : shownCount);
  const latest = visible[visible.length - 1];
  if (shown.length === 0) return null;

  return (
    <div className={running ? "lc-agent-process lc-agent-process-running" : "lc-agent-process"}>
      <button
        type="button"
        className="lc-agent-process-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        {running && <span className="lc-agent-spinner" aria-hidden />}
        <span className="lc-agent-process-chevron" aria-hidden />
        <span className="lc-agent-process-label">
          {running
            ? processLine(latest)
            : `Thinking · ${shown.length} step${shown.length === 1 ? "" : "s"}`}
        </span>
      </button>
      {expanded && (
        <ol className="lc-agent-process-steps">
            {visible.map((event, index) => {
              const key = eventKey(event, index);
              const body = event.detail?.trim() ?? "";
              const canOpen = body.length > 0 && body !== processLine(event);
              return (
                <li
                  key={key}
                  className={[
                    "lc-agent-process-step",
                    event.status === "rejected" ? "lc-agent-process-step-rejected" : "",
                    running && index === visible.length - 1 ? "lc-agent-process-step-current" : "",
                    openKey === key ? "is-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className="lc-agent-process-step-btn"
                    aria-expanded={openKey === key}
                    disabled={!canOpen}
                    onClick={() => setOpenKey((current) => (current === key ? null : key))}
                  >
                    {processLine(event)}
                  </button>
                  {canOpen && openKey === key ? (
                    <div className="lc-agent-process-step-body">{body}</div>
                  ) : null}
                </li>
              );
            })}
        </ol>
      )}
    </div>
  );
}
