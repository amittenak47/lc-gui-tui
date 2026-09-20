import { useId, useReducer, useRef } from "react";

import { STAGE_LABELS, type CoachProcessEvent } from "../api/types";
import { AgentRichText } from "./AgentRichText";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { DEFAULT_AGENT_DISPLAY_PREFS, type AgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { newThinkingDisclosure, thinkingStepKey, thinkingStepColor, type ThinkingDisclosureState } from "./thinkingDisplay";

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

/**
 * What the coach did, one line per stage or tool call.
 *
 * Each step is tappable: the step's `detail` opens inline. `reason` stages
 * stay here as Thinking. The uncut chain-of-thought is the Reasoning fold.
 */
export function ProcessBlock({
  events,
  running,
  onCollapsed,
  displayPrefs = DEFAULT_AGENT_DISPLAY_PREFS,
  disclosure,
  collapse = false,
}: {
  events: CoachProcessEvent[];
  running: boolean;
  onCollapsed?: () => void;
  displayPrefs?: AgentDisplayPrefs;
  disclosure?: ThinkingDisclosureState;
  collapse?: boolean;
}) {
  const localState = useRef(newThinkingDisclosure());
  const state = disclosure ?? localState.current;
  const [, redraw] = useReducer(value => value + 1, 0);
  const regionId = useId();
  const shown = events.filter(
    (event) => event.label !== "done" && !isReasoningEvent(event),
  );
  const expanded = state.sectionOpen ?? !(collapse || (!running && displayPrefs.autoCollapseThinking));
  const visible = shown;
  if (shown.length === 0) return null;

  return (
    <div className={running ? "lc-agent-process lc-agent-process-running" : "lc-agent-process"}>
      <button
        type="button"
        className="lc-agent-process-toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => {
          state.sectionOpen = !expanded; redraw();
          // Manual expansion must not strand an answer waiting for an exit.
          if (!expanded) onCollapsed?.();
        }}
      >
        {running && <span className="lc-agent-spinner" aria-hidden />}
        <span className="lc-agent-process-chevron" aria-hidden />
        <span className="lc-agent-process-label">
          {running ? "Thinking…" : `Thinking · ${shown.length} step${shown.length === 1 ? "" : "s"}`}
        </span>
      </button>
      <AnimatedDisclosure open={expanded} onExitComplete={onCollapsed} animateInitial={running}>
        <ol id={regionId} className="lc-agent-process-steps">
            {visible.map((event, index) => {
              const key = thinkingStepKey(event, index);
              const body = event.detail?.trim() ?? "";
              const stepOpen = state.steps[key] ?? !displayPrefs.collapseThinkingSteps;
              const toggle = () => { state.steps[key] = !stepOpen; redraw(); };
              const contentId = `${regionId}-step-${index}`;
              // Provider deltas already arrive incrementally. Do not delay
              // them with a reveal timer that each incoming delta resets.
              const revealBufferedStep = !event.updateId;
              return (
                <li
                  key={key}
                  data-thinking-color={displayPrefs.colorThinkingSteps ? thinkingStepColor(key) : undefined}
                  className={[
                    "lc-agent-process-step",
                    event.status === "rejected" ? "lc-agent-process-step-rejected" : "",
                    running && index === visible.length - 1 ? "lc-agent-process-step-current" : "",
                    stepOpen ? "is-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={event => {
                    const target = event.target as HTMLElement;
                    if (target.closest("button, a, input, textarea, select, [contenteditable]")) return;
                    if (window.getSelection()?.toString()) return;
                    toggle();
                  }}
                >
                  <button
                    type="button"
                    className="lc-agent-process-step-toggle"
                    aria-label={`${stepOpen ? "Collapse" : "Expand"} thought ${index + 1}`}
                    aria-expanded={stepOpen} aria-controls={contentId} onClick={toggle}
                  ><span aria-hidden>{stepOpen ? "▾" : "▸"}</span></button>
                  <div id={contentId} className="lc-agent-process-step-content">
                    {stepOpen ? <AgentRichText text={body || processLine(event)}
                      animate={running && revealBufferedStep} animateInitial={running && revealBufferedStep && !(key in state.steps)}
                      className="lc-agent-process-step-body" /> : <span className="lc-agent-process-step-excerpt">{processLine(event)}</span>}
                  </div>
                </li>
              );
            })}
        </ol>
      </AnimatedDisclosure>
    </div>
  );
}
