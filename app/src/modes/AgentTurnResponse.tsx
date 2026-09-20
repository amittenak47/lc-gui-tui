import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CoachProcessEvent } from "../api/types";
import { ProcessBlock, isReasoningEvent, reasoningBodyForTurn } from "./ProcessBlock";
import { ReasoningBlock } from "./ReasoningBlock";
import { AgentRichText } from "./AgentRichText";
import { ThinkingDots } from "./ThinkingDots";

/** Presentation state only. The canonical reply/events remain in the transcript. */
export function AgentTurnResponse({ pending, events = [], reasoning, text, assistant, children }: {
  pending: boolean; events?: CoachProcessEvent[]; reasoning?: string;
  text: string; assistant: boolean; children?: ReactNode;
}) {
  const [phase, setPhase] = useState<"working" | "collapsing" | "answer">(pending ? "working" : "answer");
  const wasLive = useRef(pending);
  const hasSteps = events.some(event => event.label !== "done" && !isReasoningEvent(event));
  const body = reasoningBodyForTurn(reasoning, events);
  const finishCollapse = useCallback(() => setPhase(current => current === "collapsing" ? "answer" : current), []);
  useEffect(() => {
    if (pending) { wasLive.current = true; setPhase("working"); return; }
    if (phase === "working") {
      const instant = document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      setPhase(hasSteps && !instant ? "collapsing" : "answer");
    }
  }, [pending, phase, hasSteps]);
  useEffect(() => {
    if (phase !== "collapsing") return;
    // Backgrounding can suspend motion's RAF. Never strand a completed reply.
    const onHidden = () => { if (document.hidden) finishCollapse(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [phase, finishCollapse]);
  const showAnswer = !pending && phase === "answer";
  return <>
    {(hasSteps || (body && showAnswer)) && <div className="lc-agent-think-stack">
      {hasSteps && <ProcessBlock events={events} running={pending || phase === "working"}
        onCollapsed={finishCollapse} />}
      {body && showAnswer && <ReasoningBlock text={body} running={false} />}
    </div>}
    {pending && <ThinkingDots />}
    {children}
    {showAnswer && <AgentRichText text={text} animate={assistant}
      animateInitial={assistant && wasLive.current} className="lc-agent-turn-body" />}
  </>;
}
