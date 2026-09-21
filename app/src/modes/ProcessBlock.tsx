import { useId, useReducer, useRef } from "react";

import { STAGE_LABELS, type CoachProcessEvent } from "../api/types";
import { useWordReveal } from "./AgentRichText";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { DEFAULT_AGENT_DISPLAY_PREFS, type AgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { newThinkingDisclosure, thinkingStepKey, thinkingStepColor, type ThinkingDisclosureState } from "./thinkingDisplay";
import { coalesceReasonListItems } from "./processEvents";
import { chunkReasonEvents } from "./reasonChunks";

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

const GENERIC_STAGE_TITLES = new Set(["Thinking…", "Thinking", "Working…"]);

export function sentenceCase(text: string): string {
  const match = text.match(/^(\s*)(\S)([\s\S]*)$/);
  if (!match) return text;
  return `${match[1]}${match[2]!.toLocaleUpperCase()}${match[3]}`;
}

function oneLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function normalizeTitle(text: string): string {
  return text.replace(/[.…]+$/u, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function titlesMatch(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  return Boolean(left) && left === right;
}

function headingLine(text: string): string {
  return oneLine(text).replace(/^#+\s*/, "").replace(/^\d+[.)]\s*/, "").replace(/:+$/u, "").trim();
}

function isShortCompleteThought(text: string): boolean {
  if (text.includes("\n") || text.length > 72) return false;
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 1;
}

function toGerund(verb: string): string {
  const v = verb.toLowerCase();
  if (v === "see") return "Seeing";
  if (v.endsWith("ie")) return sentenceCase(`${v.slice(0, -2)}ying`);
  if (v.endsWith("e") && !v.endsWith("ee")) return sentenceCase(`${v.slice(0, -1)}ing`);
  return sentenceCase(`${v}ing`);
}

const REASON_SUMMARY: Array<[RegExp, string]> = [
  [/\bthe student is asking\b|\bthey(?:'re| are) asking\b|\basking about\b/, "What they're asking"],
  [/\blet me re-?read\b|\bre-?read the\b/, "Re-reading"],
  [/\blet me explain\b/, "Explaining"],
  [/\blet me write\b/, "Writing it up"],
  [/\blet me look\b|\blet me check\b|\blet me see\b/, "Checking"],
  [/^wait\b/, "Reconsidering"],
  [/\bkey insight\b/, "Key insight"],
  [/^actually\b/, "Correction"],
  [/\bso the answer\b|^the answer is\b/, "The answer"],
  [/\bfrom the (retrieved|document|context|text|book)\b/, "From the document"],
  [/\bdoesn(?:'t|’t) actually\b/, "What's missing"],
  [/\bretrieved (chunk|context|passage)\b/, "Retrieved context"],
  [/\bthe (document|text|book) (says|mentions|describes|doesn't|doesn’t)\b/, "What the text says"],
  [/\brecurrence\b/, "The recurrence"],
  [/\bbase cases?\b/, "Base cases"],
  [/\bdecision\b.*\b(insert|substitut|delet)/, "Choosing the edit"],
  [/\bstandard (formulation|algorithm|approach)\b/, "The standard approach"],
  [/\bworked example\b|\bwith the \S+ example\b/, "Example"],
];

function summarizeReason(text: string): string | null {
  const head = text.replace(/\s+/g, " ").trim().slice(0, 220).toLowerCase();
  for (const [pattern, label] of REASON_SUMMARY) {
    if (pattern.test(head)) return label;
  }
  const letMe = text.trim().match(/^Let me (\w+)/i);
  if (letMe) return toGerund(letMe[1]!);
  return null;
}

/** Short label for a thought — never a truncated prefix of the body. */
export function reasonTitle(detail: string | undefined): string {
  const text = (detail ?? "").trim();
  if (!text) return "Thinking";
  const summary = summarizeReason(text);
  if (summary) return summary;
  const heading = headingLine(text);
  if (
    heading.length >= 8
    && heading.length <= 48
    && !/[.!?]$/.test(heading)
    && text.length > heading.length + 8
  ) {
    return sentenceCase(heading);
  }
  if (isShortCompleteThought(text) && heading) {
    return sentenceCase(heading.replace(/[.!?]+$/u, ""));
  }
  const firstSentence = text.split(/(?<=[.!?])(?:\s+|$)/)[0]?.trim() ?? "";
  if (firstSentence.length >= 8 && firstSentence.length <= 48 && /[.!?]$/.test(firstSentence)) {
    return sentenceCase(firstSentence.replace(/[.!?]+$/u, ""));
  }
  return "Thinking";
}

/** Chip is a summary. Reason bodies are the whole thought, not the leftover. */
export function presentProcessStep(event: CoachProcessEvent): { title: string; body: string } {
  if (event.kind === "tool") {
    const title = sentenceCase(processLine(event));
    const extra = event.detail?.trim() ?? "";
    return { title, body: extra && !titlesMatch(title, extra) ? extra : "" };
  }
  if (event.label === "reason") {
    const detail = event.detail?.trim() ?? "";
    return { title: reasonTitle(detail), body: detail };
  }
  const labeled = STAGE_LABELS[event.label];
  const detail = event.detail?.trim() ?? "";
  const title =
    labeled && !GENERIC_STAGE_TITLES.has(labeled)
      ? labeled
      : detail
        ? sentenceCase(oneLine(detail))
        : labeled ?? sentenceCase(event.label);
  const body =
    detail && !titlesMatch(title, detail) && detail.includes("\n") ? detail : "";
  return { title, body };
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
  const named = STAGE_LABELS[event.label];
  if (named && GENERIC_STAGE_TITLES.has(named) && event.detail?.trim()) {
    return sentenceCase(oneLine(event.detail));
  }
  if (named) return named;
  const fallback = event.detail ?? event.label;
  return fallback ? sentenceCase(oneLine(fallback)) : event.label;
}

function ProcessStepBody({
  text,
  animate,
  animateInitial,
}: {
  text: string;
  animate: boolean;
  animateInitial: boolean;
}) {
  const shown = useWordReveal(text, animate, animateInitial);
  return (
    <div className="lc-agent-process-step-body" aria-busy={shown !== text}>
      {shown}
    </div>
  );
}

/**
 * What the coach did, one line per stage or tool call.
 *
 * Each step is tappable. Reason chips are short summaries; the body is the
 * thought verbatim. The uncut chain-of-thought is the Reasoning fold.
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
  const shown = chunkReasonEvents(coalesceReasonListItems(events.filter(
    (event) => event.label !== "done" && !isReasoningEvent(event),
  )));
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
              const { title, body } = presentProcessStep(event);
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
                  ><span className="lc-agent-process-step-dot" aria-hidden /></button>
                  <div id={contentId} className="lc-agent-process-step-content">
                    <span className="lc-agent-process-step-excerpt">{title}</span>
                    {stepOpen && body ? (
                      <ProcessStepBody
                        text={body}
                        animate={running && revealBufferedStep}
                        animateInitial={running && revealBufferedStep && !(key in state.steps)}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
        </ol>
      </AnimatedDisclosure>
    </div>
  );
}
