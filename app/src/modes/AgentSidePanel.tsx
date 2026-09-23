/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Ask / Draw / Review are composer flags that ride along with Send, not
 * standalone actions. Ask skips the staged pipeline; Review runs it.
 * Structured results (review, tests, nudges) render inside the message list
 * as assistant turns.
 */

import { type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BridgeResponse, CoachProcessEvent, ReviewResponse } from "../api/types";
import { HoldButton } from "../components/HoldButton";
import { AgentPanelSash } from "../components/AgentPanelSash";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { Tip } from "../components/Tip";
import { LONG_PRESS_MS, SELECT_HOLD_ARM_MS } from "../util/gesture";
import { footnoteChipLabel, type DocFootnote } from "../util/docFootnotes";
import { assembleAskPrompt, PROBLEM_ASK_CLIP_CHARS } from "./coachMarkContext";
import { useWordReveal } from "./AgentRichText";
import { AgentTurnResponse } from "./AgentTurnResponse";
import { useChatFollow } from "./useChatFollow";
import { useAgentSheet } from "./useAgentSheet";
import { useAgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { newThinkingDisclosure, type ThinkingDisclosureState } from "./thinkingDisplay";
import { AgentMessageBubble } from "./AgentMessageBubble";
import {
  cycleAgentReasoning,
  loadAgentReasoningLevel,
  saveAgentReasoningLevel,
  type AgentReasoningLevel,
} from "../util/agentPrefs";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { useIsMobile } from "../util/mobile";
import { PHOTO_ATTACH_LIMIT, pickPhotos } from "../util/photoAttach";
import { drawingHeading } from "../viz/vizProse";
import type { MessageDrawing } from "../viz/drawingState";
import type { ArtifactRef } from "../util/padArtifacts";
import type { AgentArtifactProposal } from "../util/agentArtifacts";
import { ArtifactCards } from "./ArtifactCards";
import { DrawingPreview } from "../viz/DrawingPreview";
import { Timeline } from "../viz/Timeline";
import { BridgePanel } from "./RevealDialog";
import { ReviewPanel } from "./ReviewPanel";
import {
  groupThreads,
  messageReplyExcerpt,
  messageThreadRoot,
  showsReplyStub,
  visibleThreadMessages,
} from "./coachThreads";
import { listSessions, orderSessions, organizeIntoSessions } from "./coachSessions";

export type CoachMode = "review" | "ambient";

/**
 * The ambient coach polls the board every 120 seconds. Kept off until the
 * rest of the app is solid: on a slowly changing board it re-asked the same
 * question, and on a local model it blocked the pen while thinking. Flip this
 * to `true` to enable — `App` already wires the socket, probe/capture, and
 * nudge UI; this flag is the only gate.
 */
export const AMBIENT_ENABLED = false;

const ROLE_LABEL: Record<AgentChatMessage["role"], string> = {
  user: "You",
  assistant: "Agent",
  system: "System",
  app: "Tests",
};

function turnKind(role: AgentChatMessage["role"]): string {
  return role === "user" || role === "system" || role === "app" ? role : "assistant";
}

/** Catalog pins in the thread — a status line, not a Tests bubble. */
function isSavedAttachmentNotice(message: AgentChatMessage) {
  return (
    message.role === "app" &&
    Boolean(message.artifacts?.length) &&
    (!message.content.trim() || message.content === "Saved attachment")
  );
}

/**
 * Controls that must stay tappable — do not start a message hold on these.
 * Process toggles are fine to hold through; thread open and reply stubs
 * navigate on tap and should not steal into the menu.
 */
function isLongPressBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "a, input, textarea, select, .lc-agent-thread-open, .lc-agent-reply-stub, .lc-agent-turn-tool, .lc-agent-proposal-save, .lc-artifact-line-icon",
    ),
  );
}

/** Longest stub shown in a reply bubble before it is cut. */
const REPLY_EXCERPT_MAX = 160;
const THREAD_MOTION_IN_MS = 200;
const THREAD_MOTION_OUT_MS = 170;
/** Safety net: an interrupted animation must not strand the panel mid-transition. */
const THREAD_MOTION_TIMEOUT_MS = THREAD_MOTION_IN_MS + THREAD_MOTION_OUT_MS + 50;

/** How the transcript is moving between the room and a thread. */
type ThreadMotion = "idle" | "enter" | "exit" | "back";

/**
 * A one-line trace of the quoted turn.
 *
 * Collapsed to a single line: a stub is there to say *which* message is being
 * answered, and a stub that reproduced the paragraph breaks of a long coach
 * answer would be the answer again rather than a reference to it.
 */
export function replyExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > REPLY_EXCERPT_MAX
    ? `${flat.slice(0, REPLY_EXCERPT_MAX - 1).trimEnd()}…`
    : flat;
}

/** Ask answered in prose. Draw was not requested, so the turn can offer one. */
export function offerDrawFor(message: AgentChatMessage, messages: readonly AgentChatMessage[]): boolean {
  if (message.role !== "assistant" || message.pending || message.drawing) return false;
  if (message.requestState && message.requestState !== "completed") return false;
  if (!message.content.trim()) return false;
  const index = messages.findIndex((item) => item.id === message.id);
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = messages[i];
    if (!previous || previous.deletedAt || previous.role !== "user") continue;
    const flags = previous.flags ?? [];
    return flags.includes("Ask") && !flags.includes("Draw");
  }
  return false;
}

function replyRefFor(message: AgentChatMessage): CoachReplyRef {
  return {
    id: message.id,
    role: message.role,
    excerpt: messageReplyExcerpt(message),
  };
}

/**
 * Scroll when the thread grows or a turn's content changes — not when the
 * student only scrubs a drawing's frameIndex (Prev / Play / Next).
 */
function coachScrollSignature(messages: AgentChatMessage[]): string {
  return messages
    .map((message) =>
      [
        message.id,
        message.role,
        message.content,
        message.pending ? "1" : "0",
        message.processEvents?.length ?? 0,
        message.reasoning?.length ?? 0,
        message.flags?.join(",") ?? "",
        message.drawing?.program.id ?? "",
        message.drawing?.expanded ? "1" : "0",
        message.attachments?.length ?? 0,
        message.review ? "1" : "0",
        message.bridge ? "1" : "0",
      ].join("\x1f"),
    )
    .join("\x1e");
}

async function copyToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    await navigator.clipboard.writeText(trimmed);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = trimmed;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(area);
    }
  }
}

/*
 * Review and (+) are mutually exclusive, and the reason is that Review cannot
 * carry an attachment.
 *
 * `images` rides `POST /coach/ask` and nothing else. A send with Review on goes
 * to `submitForReview`, whose body is built from the board snapshot — the
 * staged photos would stay on the local bubble and never leave the browser.
 * Greying the pair out is the honest version of that: the alternative is
 * showing someone their photo attached to a message the coach answers without
 * having seen it. Only Review diverts; Lazy, Draw and Annotate all still reach
 * `askCoach`, so photos are genuinely sent on those and they stay enabled.
 */
const REVIEW_DROPS_PHOTOS = "Review sends the board, not attachments";

/**
 * Which surface the coach is attached to.
 *
 * `problem` has a solution file, a test run and a review pipeline behind it, so
 * the full flag set means something. `pad` — scratchpad and the document pads —
 * has no Review/Lazy pipeline and no analyse-on-send cadence, so those stay
 * hidden. Draw is available: Ask can emit a viz program onto the open pad.
 * Scratchpad omits footnotes (`allowAnnotations`), but keeps the Annotations
 * menu for Ink and the agent options.
 */
export type AgentSurface = "problem" | "pad";

export const ASK_PRESETS = [
  { id: "de_jargon", label: "De-jargon" },
  { id: "explain_math", label: "Explain math" },
  { id: "analyze_methodology", label: "Methodology" },
  { id: "reverse_engineer", label: "Reverse-engineer" },
] as const;

export type AskPresetId = (typeof ASK_PRESETS)[number]["id"];

/**
 * Which slice of the coach sheet fills the panel.
 *
 * Landscape on a tablet stacks the document, the thread, and the composer
 * into three thin layers. These are viewing modes, not `<details>` folds:
 * the other slice stays mounted and comes back in one tap.
 */
export type ChatPaneFocus = "split" | "messages" | "composer";

export function nextChatPaneFocus(
  current: ChatPaneFocus,
  pane: "messages" | "composer",
): ChatPaneFocus {
  return current === pane ? "split" : pane;
}

/** Page tags, composer chips, and the picker itself stay live while it is open. */
export function markMenuClickShouldKeepOpen(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      [
        ".lc-agent-mark-menu",
        ".lc-agent-footnote-menu",
        ".lc-agent-annotate-wrap",
        ".lc-agent-mark-chips",
        ".lc-doc-footnote",
        ".lc-fn-badge",
        ".lc-page-marks-slot",
      ].join(", "),
    ),
  );
}

/** Fixed so cycling Reasoning Low → Medium does not grow the panel. */
const MARK_MENU_WIDTH_PX = 216;

function markMenuPosition(rect: Pick<DOMRect, "left" | "top">): { left: number; bottom: number } {
  return {
    left: Math.max(12, Math.min(rect.left, window.innerWidth - MARK_MENU_WIDTH_PX - 12)),
    bottom: window.innerHeight - rect.top + 6,
  };
}

function PaneExpandButton({
  pane,
  focus,
  overlay,
  onToggle,
}: {
  pane: "messages" | "composer";
  focus: ChatPaneFocus;
  overlay?: boolean;
  onToggle: (pane: "messages" | "composer") => void;
}) {
  const expanded = focus === pane;
  const label = expanded
    ? pane === "messages"
      ? "Show the chat box"
      : "Show the conversation"
    : pane === "messages"
      ? "Expand conversation"
      : "Expand chat box";
  return (
    <button
      type="button"
      className={[
        "lc-flag",
        "lc-agent-pane-expand",
        expanded ? "lc-flag-active is-expanded" : "",
        overlay ? "is-overlay" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={expanded}
      aria-label={label}
      title={label}
      onClick={() => onToggle(pane)}
    >
      <svg className="lc-agent-pane-expand-icon" viewBox="0 0 16 16" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          <path className="lc-pane-arrow lc-pane-arrow-ne" d="M12.5 6.5v-3h-3M12.5 3.5l-4 4" />
          <path className="lc-pane-arrow lc-pane-arrow-sw" d="M3.5 9.5v3h3M3.5 12.5l4-4" />
        </g>
      </svg>
    </button>
  );
}

function InkScribbleIcon() {
  return (
    <svg className="lc-agent-composer-icon lc-agent-scribble-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.1 10.9c.8-3.4 3.4-3.6 4.1-.4.3 1.4-.6 2.2-1.3 1.4 2.1 1.3 4.4-.8 5.3-3.1 1.1-2.7 4.2-2.1 4.7.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="lc-agent-composer-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.2 2.8 13.7 8 2.2 13.2 4.4 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M4.4 8h9.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="lc-agent-composer-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 3.2v9.6M3.2 8h9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg className="lc-agent-composer-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3.2 2.4h7.1L13.6 5.7v7.9H3.2V2.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M5 2.4v3.2h5.2V2.4M5.2 13.6v-3.6h5.6v3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg className="lc-agent-composer-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M5.4 8.1 8.8 4.7a2.35 2.35 0 0 1 3.3 3.3l-4.6 4.6a3.2 3.2 0 0 1-4.5-4.5l4.4-4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FailIcon() {
  return (
    <svg className="lc-agent-turn-fail-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.7v4.1" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.85" fill="currentColor" />
    </svg>
  );
}

/** Square stop mark, same circle as {@link FailIcon}. */
function StopIcon() {
  return (
    <svg className="lc-agent-turn-fail-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5.55" y="5.55" width="4.9" height="4.9" rx="0.7" fill="currentColor" />
    </svg>
  );
}

function turnBody(message: AgentChatMessage): string {
  if (message.requestState === "cancelled" && message.content.trim().toLowerCase() === "cancelled") return "";
  return message.content;
}

function statusTip(message: AgentChatMessage): string | null {
  if (message.requestState === "failed") {
    return message.requestNote?.trim() || "This message was not sent.";
  }
  if (message.requestState === "cancelled") {
    return message.requestNote?.trim() || "You stopped this message.";
  }
  if (message.requestState === "interrupted") {
    return message.requestNote?.trim() || "This request was interrupted.";
  }
  if (message.requestState === "running") return "The agent is replying.";
  if (message.requestState === "completed") return "Sent.";
  return null;
}

/** Check mark, same circle as {@link FailIcon}. */
function CheckIcon({ settled }: { settled?: boolean }) {
  return (
    <svg
      className={`lc-agent-turn-fail-icon${settled ? " is-settled" : ""}`}
      viewBox="0 0 16 16"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.1 8.15 7.05 10.15 10.95 5.85"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The in-flight mark and the success mark share one box, so a finish replaces
 * the spinner instead of jumping to a new spot.
 */
function RunMark({ done }: { done: boolean }) {
  const sawRun = useRef(false);
  const settled = done && sawRun.current;
  useEffect(() => {
    if (!done) sawRun.current = true;
  }, [done]);
  if (!done) {
    return (
      <svg className="lc-agent-turn-fail-icon lc-agent-turn-run" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.28" />
        <path
          d="M8 1.8A6.2 6.2 0 0 1 14.2 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return <CheckIcon settled={settled} />;
}

function turnArtifactProposal(message: AgentChatMessage): AgentArtifactProposal {
  if (message.drawing) {
    return {
      kind: "whiteboard",
      title: message.drawing.program.title || "Diagram",
      programs: [message.drawing.program],
    };
  }
  return {
    kind: "markdown",
    title: message.role === "assistant" ? "Answer.md" : "Note.md",
    source: message.content,
  };
}

function saveTurnLabel(message: AgentChatMessage): string {
  if (message.drawing) return "Save drawing";
  return message.role === "assistant" ? "Save answer" : "Save note";
}

const COPY_ACK_MS = 700;
const COPY_FADE_MS = 180;

interface MessageMenuState {
  messageId: string;
  top: number;
  left: number;
  /** Message fills most of the chat — selection uses outline only, no scale-up. */
  tall: boolean;
}

/**
 * The turn a reply is hanging off, kept small on purpose.
 *
 * An id, who said it, and enough text to recognise it — not the whole message.
 * The thread is a pointer, so a long coach answer does not get copied into
 * every reply to it, and the excerpt still renders when the original has
 * scrolled far out of view or been trimmed from the persisted thread.
 */
export interface CoachReplyRef {
  id: string;
  role: AgentChatMessage["role"];
  excerpt: string;
}

export interface AgentSendFlags {
  /** Ask the coach a question without the staged review pipeline. */
  ask: boolean;
  /** Ask the coach to draw on the board. */
  draw: boolean;
  /** Attach the current board and run the staged review pipeline. */
  reviewBoard: boolean;
  /**
   * Fill the parts of solution.py the board already justifies (no reference
   * dump). Works with Draw / Review / a plain question.
   */
  lazy: boolean;
  /**
   * Ink and what it was drawn on: every page carrying the writer's marks, the
   * backdrop composited under them so the strokes mean something.
   *
   * Independent of Review — Ask alone must not sneak the board in.
   */
  handwriting: boolean;
  /**
   * The parts that were singled out, rather than everything.
   *
   * On a reading surface those are the mark blocks attached to this send; on a
   * board it is the region in front of the writer. The question "what about
   * this bit" is a different question from "look at my work", and sending the
   * whole board for it makes the model rule out forty crops first.
   */
  annotations: boolean;
  /**
   * Ask the model to think out loud. Sticky across sends. Off / low / medium / high.
   */
  reasoning: AgentReasoningLevel;
  /**
   * Images the writer attached with (+), as base64 PNGs.
   *
   * Not the same thing as {@link handwriting}: those thumbnails are the board
   * being described back to the coach, these are evidence from outside it — a
   * photo of the page, a screenshot of an error, a diagram from somewhere else.
   * Absent rather than empty when nothing was attached.
   */
  photos?: CoachAttachment[];
  /**
   * A passage picked off the page, in full.
   *
   * Carried beside the message rather than inside it — the writer's text is
   * what they typed, and the quote is what they pointed at. The caller
   * prefixes it onto the prompt, the same way it does a reply's excerpt.
   */
  pageQuote?: string;
  documentView?: import("./documentView").DocumentViewContext;
  /** The message this turn is answering, when the writer quoted one. */
  replyTo?: CoachReplyRef;
  /** The thread this send belongs to, or null when it is addressed to the room. */
  threadRootId?: string | null;
  /** Document Ask slash preset — swaps the daemon system prompt. */
  askPreset?: AskPresetId | null;
}

/** Mirrored on a pending assistant turn — flags + what the user sent. */
export interface CoachPendingAck {
  flags: string[];
  hasQuestion: boolean;
  boardAttached: boolean;
  photoCount: number;
}

export interface CoachAttachment {
  label: string;
  /** Identity of the frozen document selection this PNG depicts. */
  documentCaptureId?: string;
  /** Raw base64 PNG (no data: prefix). */
  png: string;
  /**
   * When false, the bubble still shows the picture but Ask does not send it.
   * A text highlight already has the words. A boxed region still sends its
   * PNG, including when the box also contains labels or a caption.
   */
  sendToModel?: boolean;
  /**
   * A small copy of the same image, when one exists.
   *
   * Present on photos the writer attached, where `png` is sized for a vision
   * model and far too large to keep in the transcript — the bubble draws this
   * and the persisted thread stores only this. Absent on board thumbs, which
   * are already small by construction.
   */
  thumb?: string;
}

export interface AgentChatMessage {
  artifactProposals?: AgentArtifactProposal[];
  artifactFootnoteIds?: string[];
  id: string;
  /**
   * `app` is the harness talking, not the student and not the coach — test
   * results land here. It renders as its own turn and is sent to the model
   * alongside the next question.
   */
  role: "user" | "assistant" | "system" | "app";
  content: string;
  at: number;
  /** Structured review — rendered once as a card, not duplicated as prose. */
  review?: ReviewResponse;
  /** Hold-to-reveal bridge, nested under the review that offered it. */
  bridge?: BridgeResponse;
  /** True while the bridge request is in flight — inline loading in this turn. */
  bridgePending?: boolean;
  /** Inline error if the bridge request failed after confirm. */
  bridgeError?: string | null;
  /** Layout thumbnails when Review board was attached. */
  attachments?: CoachAttachment[];
  /** Persistent content links; thumbnails remain separate, expendable previews. */
  artifacts?: ArtifactRef[];
  /** Coach diagram — expand/collapse controls board visibility. */
  drawing?: MessageDrawing;
  /** Composer flags that rode along with Send — footnotes under the bubble text. */
  flags?: string[];
  /**
   * What the coach did on the way to this answer, in order, as the daemon
   * reported it. Kept on the turn rather than in a global status line so it
   * survives scrollback: "which stage found the counterexample?" is a question
   * about a specific answer, asked after the fact.
   */
  processEvents?: CoachProcessEvent[];
  /** Full chain-of-thought, uncut. Separate from {@link processEvents} steps. */
  reasoning?: string;
  /** The request is still in flight — this turn is a placeholder. */
  pending?: boolean;
  /** While {@link pending} — local ack before the daemon's first stage frame. */
  pendingAck?: CoachPendingAck;
  /** User message waiting in the FIFO send queue while the coach is busy. */
  queued?: boolean;
  requestId?: string;
  retryOf?: string;
  requestState?: import("./coachSendCoordinator").SendState;
  /** Why a send failed or was stopped — shown on the status icon, not in the bubble. */
  requestNote?: string;
  /**
   * The question-sized conversation this turn belongs to.
   *
   * Assigned on the client (`session-` plus the question's id) and stored on
   * the message so a reload and a sync replica keep the same grouping.
   */
  sessionId?: string;
  /**
   * Hidden from the chat, kept in the transcript.
   *
   * A removed turn stays in the saved array so another device can see that it
   * was deleted. Absent on a live turn.
   */
  deletedAt?: number;
  /**
   * The turn this one is answering.
   *
   * Quoting used to paste the coach's whole answer into the composer as `>`
   * prose, which made the reply unreadable before it was even sent and left no
   * relationship behind once it was — the quote was just more text in a new
   * message. Holding the reference instead means the bubble can show a stub
   * and the model can be told what is being replied to, separately.
   */
  replyTo?: CoachReplyRef;
}

export interface AgentSidePanelProps {
  onSaveArtifact?: (message: AgentChatMessage, proposal: AgentArtifactProposal, index?: number) => void;
  onOpenArtifact?: (ref: ArtifactRef) => void;
  onManageArtifacts?: (message?: AgentChatMessage) => void;
  showProcess?: boolean;
  open: boolean;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  /** Open / close the coach (header toggle + sheet snap). */
  onOpenChange?: (open: boolean) => void;
  /** @deprecated Prefer onOpenChange — kept for call sites that only close. */
  onClose?: () => void;
  busy: boolean;
  /** Board/App error string — durable in the panel; the 5s board banner still exists. */
  error?: string | null;
  thinking?: boolean;
  /** Phased status while the local model works (replaces a bare "Thinking…"). */
  thinkingPhase?: string | null;
  messages: AgentChatMessage[];
  /**
   * Scratchpad: no solution.py, no review pipeline, no board regions to draw
   * into. Ask is pinned on and the other flags are disabled.
   */
  askOnly?: boolean;
  /**
   * Problem attempt or reading pad — decides which composer controls exist at
   * all. Defaults to `problem` so nothing changes for the attempt flow.
   */
  agentSurface?: AgentSurface;
  /**
   * Mark-block flag + picker. Scratchpad has no custom block select, so this
   * is false there; document pads and problems keep it.
   */
  allowAnnotations?: boolean;
  /** Slash presets for document Ask (annotate pad only). */
  documentPresets?: boolean;
  /**
   * A quote pushed in from outside the panel — the document pad's "Coach" on a
   * text selection.
   *
   * Carries a token rather than being cleared by the panel, so quoting the same
   * sentence twice still lands: the effect keys off the token changing, and the
   * caller owns the value. The panel never writes back to it.
   */
  quoteSeed?: { token: number; text: string; attachment?: CoachAttachment; view?: import("./documentView").DocumentViewContext } | null;
  /**
   * Open this thread — a footnote tapped on the page. Same token contract as
   * {@link quoteSeed}; `null` id returns to the room.
   */
  focusThread?: { token: number; rootId: string | null } | null;
  /** Mark panels queued onto this send. */
  attachedMarks?: Array<{
    id: string;
    number?: number;
    title?: string;
    color?: string;
    palette?: string[];
  }>;
  /** Full mark bodies for the pre-send pack preview. */
  attachedFootnotes?: DocFootnote[];
  /** Daemon Ask clip for this workspace — pad vs problem. */
  askClipChars?: number;
  onRemoveAttached?: (id: string) => void;
  /** Every mark on the open document — attach by tapping a mark on the page. */
  annotationChoices?: Array<{
    id: string;
    number?: number;
    title?: string;
    color?: string;
    palette?: string[];
  }>;
  onToggleAttached?: (id: string) => void;
  onSend: (text: string, flags: AgentSendFlags, mode?: "queue" | "merge") => void | Promise<boolean>;
  onAbortMessage?: (id: string) => void;
  onRetryMessage?: (id: string) => void;
  onEditMessage?: (id: string, text?: string) => boolean;
  onCancelEdit?: (id: string) => void;
  /** Hide this turn, and replies that hang off it, from the chat. */
  onDeleteMessage?: (id: string) => void;
  /** The open thread, so the caller can narrow what the coach is told. */
  onThreadChange?: (rootId: string | null) => void;
  /** Opens the hold-to-reveal dialog for the review on this message. */
  onRequestBridge?: (messageId: string) => void;
  /** Expand/collapse a message's drawing section (and sync the board). */
  onToggleDrawing?: (messageId: string, expanded: boolean) => void;
  /** Scrub a multi-frame drawing that is currently expanded. */
  onDrawingFrame?: (programId: string, frameIndex: number) => void;
  /** Structured cards (tests, ambient, …) rendered in the thread. */
  children?: ReactNode;
  /** When true, parked sheet ignores drag-open from the bottom. Close still works. */
  sheetDragLocked?: boolean;
}

const SESSION_PINS_KEY = "whiteboard.agent.sessionPins.v1";

function loadSessionPins(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_PINS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

function saveSessionPins(ids: readonly string[]) {
  localStorage.setItem(SESSION_PINS_KEY, JSON.stringify(ids));
}

export function AgentSidePanel({
  onSaveArtifact,
  onOpenArtifact,
  onManageArtifacts,
  showProcess = true,
  open,
  mode,
  onModeChange,
  onOpenChange,
  onClose,
  busy,
  error = null,
  thinking = false,
  thinkingPhase = null,
  messages,
  askOnly = false,
  agentSurface = "problem",
  allowAnnotations = true,
  documentPresets = false,
  quoteSeed = null,
  focusThread = null,
  attachedMarks = [],
  attachedFootnotes = [],
  askClipChars = PROBLEM_ASK_CLIP_CHARS,
  onRemoveAttached,
  annotationChoices = [],
  onToggleAttached,
  onSend,
  onAbortMessage, onRetryMessage, onEditMessage, onCancelEdit, onDeleteMessage,
  onThreadChange,
  onRequestBridge,
  onToggleDrawing,
  onDrawingFrame,
  children,

}: AgentSidePanelProps) {
  const displayPrefs = useAgentDisplayPrefs();
  const thinkingDisclosures = useRef(new Map<string, ThinkingDisclosureState>());
  useEffect(() => {
    const ids = new Set(messages.map(message => message.id));
    for (const id of thinkingDisclosures.current.keys()) if (!ids.has(id)) thinkingDisclosures.current.delete(id);
  }, [messages]);
  const disclosureFor = (id: string) => {
    let state = thinkingDisclosures.current.get(id);
    if (!state) { state = newThinkingDisclosure(); thinkingDisclosures.current.set(id, state); }
    return state;
  };
  const mobile = useIsMobile();
  const setOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next);
      if (!next) onClose?.();
    },
    [onClose, onOpenChange],
  );
  const [draft, setDraft] = useState("");
  const [chatFocus, setChatFocus] = useState<ChatPaneFocus>("split");
  const toggleChatFocus = useCallback((pane: "messages" | "composer") => {
    setChatFocus((current) => nextChatPaneFocus(current, pane));
  }, []);
  /**
   * Pads keep Ask and Ink; document pads also keep footnotes. The
   * pipeline flags and the cadence toggles are gone rather than greyed. See
   * {@link AgentSurface}.
   */
  const padSurface = agentSurface === "pad";
  /** Handwriting is greyed only where there is genuinely nothing to attach. */
  const annotateUnavailable = askOnly && !padSurface;
  const [draw, setDraw] = useState(false);
  const [reviewBoard, setReviewBoard] = useState(false);
  const [lazy, setLazy] = useState(false);
  const cycleBoard = useCallback(() => {
    if (padSurface) {
      setDraw((on) => !on);
      setReviewBoard(false);
      setLazy(false);
      return;
    }
    if (draw) {
      setDraw(false);
      setReviewBoard(true);
    } else if (reviewBoard) {
      setReviewBoard(false);
      setLazy(true);
    } else if (lazy) {
      setLazy(false);
    } else {
      setDraw(true);
    }
  }, [draw, reviewBoard, lazy, padSurface]);
  const boardLabel = draw ? "Draw" : reviewBoard ? "Review" : lazy ? "Lazy" : "Ask";
  const [handwriting, setHandwriting] = useState(false);
  const [reasoning, setReasoning] = useState(loadAgentReasoningLevel);
  const [editingQueued, setEditingQueued] = useState<AgentChatMessage | null>(null);
  const [queueEditText, setQueueEditText] = useState("");
  const [annotations, setAnnotations] = useState(false);
  const [askPreset, setAskPreset] = useState<AskPresetId | null>(null);
  const attachedCount = attachedMarks?.length ?? 0;
  /** Photos staged by (+), sent with the next message and cleared after. */
  const [photos, setPhotos] = useState<CoachAttachment[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const [lightbox, setLightbox] = useState<CoachAttachment | null>(null);
  const [lightboxClosing, setLightboxClosing] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [markMenuOpen, setMarkMenuOpen] = useState(false);
  const [markMenuClosing, setMarkMenuClosing] = useState(false);
  const [markMenuPos, setMarkMenuPos] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const [footnoteMenuOpen, setFootnoteMenuOpen] = useState(false);
  const [footnoteMenuClosing, setFootnoteMenuClosing] = useState(false);
  const [footnoteMenuPos, setFootnoteMenuPos] = useState<{
    left: number;
    top: number;
    width: number;
    height?: number;
    side: "left" | "right";
  } | null>(null);
  const annotateBtnRef = useRef<HTMLButtonElement>(null);
  const markMenuRef = useRef<HTMLDivElement>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const [menuFading, setMenuFading] = useState(false);
  const copyAckTimerRef = useRef<number | null>(null);
  /** Swallow the click that follows a successful long-press (process toggle etc.). */
  const suppressClickRef = useRef(false);
  /** The turn the next send is answering, if the writer quoted one. */
  const [replyTo, setReplyTo] = useState<CoachReplyRef | null>(null);
  /**
   * A passage picked off the page, waiting to be asked about.
   *
   * The full text goes to the coach; the excerpt is what the chip shows. They
   * are kept apart so a paragraph-long quote is one line in the composer and
   * still arrives whole.
   */
  const [pageQuote, setPageQuote] = useState<{ text: string; excerpt: string } | null>(null);
  const askPackPreview = useMemo(() => {
    if (!allowAnnotations || attachedMarks.length === 0) return null;
    const asked =
      draft.trim() ||
      (pageQuote
        ? "What should I make of this?"
        : photos.length > 0
          ? "What am I looking at?"
          : "What should I focus on next?");
    const numbers = new Map<string, number>();
    for (const mark of attachedMarks) {
      if (mark.number != null) numbers.set(mark.id, mark.number);
    }
    return assembleAskPrompt({
      question: asked,
      quote: pageQuote?.text,
      marks: attachedFootnotes,
      numbers,
      budget: askClipChars,
    });
  }, [
    allowAnnotations,
    attachedMarks,
    attachedFootnotes,
    draft,
    pageQuote,
    photos.length,
    askClipChars,
  ]);
  /**
   * The thread filling the panel, or null for the main conversation.
   *
   * A thread is identified by the message it hangs off rather than by an id of
   * its own: threads are not created, they are noticed — the second reply to a
   * message is what turns two turns into a conversation about it.
   */
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadMotion, setThreadMotion] = useState<ThreadMotion>("idle");
  /** The thread we are on our way out of — scrolled back to once the room returns. */
  const exitedRootRef = useRef<string | null>(null);
  const motionTimerRef = useRef<number | null>(null);
  const threadMotionRef = useRef<ThreadMotion>("idle");

  const organized = useMemo(() => organizeIntoSessions(messages), [messages]);
  const sessions = useMemo(() => listSessions(organized), [organized]);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(loadSessionPins);
  const orderedSessions = useMemo(
    () => orderSessions(sessions, pinnedSessionIds),
    [sessions, pinnedSessionIds],
  );
  const toggleSessionPin = (sessionId: string) => {
    setPinnedSessionIds((current) => {
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [sessionId, ...current];
      saveSessionPins(next);
      return next;
    });
  };
  const deleteSession = (sessionId: string) => {
    for (const message of organized) {
      if (!message.deletedAt && message.sessionId === sessionId) onDeleteMessage?.(message.id);
    }
    setPinnedSessionIds((current) => {
      if (!current.includes(sessionId)) return current;
      const next = current.filter((id) => id !== sessionId);
      saveSessionPins(next);
      return next;
    });
  };
  const newestSessionId = sessions.at(-1)?.id ?? null;
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const [seenNewestSession, setSeenNewestSession] = useState<string | null>(null);
  const pickedIsLive = pickedSessionId != null && sessions.some((session) => session.id === pickedSessionId);
  if (newestSessionId !== seenNewestSession || (pickedSessionId != null && !pickedIsLive)) {
    setSeenNewestSession(newestSessionId);
    setPickedSessionId(newestSessionId);
  }
  const activeSessionId = pickedIsLive ? pickedSessionId : newestSessionId;
  const sessionMessages = useMemo(
    () => organized.filter((message) => !message.deletedAt && (!activeSessionId || message.sessionId === activeSessionId)),
    [organized, activeSessionId],
  );

  const { threadReplies, rootMessages } = useMemo(() => groupThreads(sessionMessages), [sessionMessages]);
  const seenMessages = useRef(new Set(messages.map(message => message.id)));
  useEffect(() => {
    for (const message of messages) seenMessages.current.add(message.id);
  }, [messages]);

  const visibleMessages = useMemo(
    () => visibleThreadMessages(sessionMessages, openThreadId, { threadReplies, rootMessages }),
    [sessionMessages, openThreadId, threadReplies, rootMessages],
  );

  useEffect(() => {
    onThreadChange?.(openThreadId);
  }, [onThreadChange, openThreadId]);

  // A thread whose root has gone (cleared history, a trimmed session) must not
  // strand the panel in a view of nothing.
  useEffect(() => {
    if (openThreadId && !sessionMessages.some((message) => message.id === openThreadId)) {
      setOpenThreadId(null);
      setThreadMotion("idle");
      exitedRootRef.current = null;
      if (motionTimerRef.current != null) {
        window.clearTimeout(motionTimerRef.current);
        motionTimerRef.current = null;
      }
    }
  }, [sessionMessages, openThreadId]);

  /*
   * A quote pushed in from the page.
   *
   * Appended rather than replacing the draft: the reader may already have half
   * a question typed, and losing it to a selection they made to *support* that
   * question would be the worst possible moment to lose it. Blockquoted so the
   * coach can see where the writer's words stop and the document's begin.
   */
  const lastQuoteTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!quoteSeed || quoteSeed.token === lastQuoteTokenRef.current) return;
    lastQuoteTokenRef.current = quoteSeed.token;
    /*
     * A quote from the page is a *reference*, not something typed.
     *
     * It used to be pasted into the draft as markdown blockquote lines, which
     * made it the writer's problem: it had to be scrolled past to reach the
     * cursor, it could be half-deleted, and a long passage filled the composer
     * so the question being asked about it was off screen. Worse, it read as
     * something they had written when they had not.
     *
     * The panel already has the right shape for this — the chip that says which
     * message a reply is answering. Same idea, same place, one line high
     * whatever the length of the passage, and a × to take it back off.
     */
    setPageQuote({ text: quoteSeed.text.trim(), excerpt: replyExcerpt(quoteSeed.text) });
    setOpenThreadId(null); setReplyTo(null);
    if (quoteSeed.attachment) setPhotos(current => [...current, quoteSeed.attachment!]);
    window.setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 0);
  }, [quoteSeed]);

  /** A footnote tapped on the page — jump the panel to the thread it made. */
  const lastFocusTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusThread || focusThread.token === lastFocusTokenRef.current) return;
    lastFocusTokenRef.current = focusThread.token;
    setOpenThreadId(focusThread.rootId);
  }, [focusThread]);

  useEffect(() => {
    threadMotionRef.current = threadMotion;
  }, [threadMotion]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chatPinned = useChatFollow(listRef, openThreadId ?? "__room__", open);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const sheet = useAgentSheet(panelRef, mobile, open, () => setOpen(false));
  const [sessionsHidden, setSessionsHidden] = useState(false);
  const [keepPanel, setKeepPanel] = useState(open || mobile);
  useEffect(() => {
    if (open || mobile) {
      setKeepPanel(true);
      return;
    }
    // Keep mounted after the first open: reopening must not rebuild a long
    // transcript before the panel can start moving. The closed shell is inert.
  }, [open, mobile]);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    armTimer: ReturnType<typeof setTimeout> | null;
    messageId: string | null;
    pointerId: number | null;
    startX: number;
    startY: number;
    moved: boolean;
    armed: boolean;
  }>({
    timer: null,
    armTimer: null,
    messageId: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    armed: false,
  });

  useEffect(() => {
    if (!open) composerRef.current?.blur();
  }, [open]);

  // Ask-only workspaces clear pipeline flags they cannot honour. Pads keep Draw.
  useEffect(() => {
    if (!askOnly) return;
    setReviewBoard(false);
    setLazy(false);
    if (!padSurface) {
      setDraw(false);
      setHandwriting(false);
    }
  }, [askOnly, padSurface]);

  /*
   * Attaching a mark arms Annotations.
   *
   * Putting a passage on the message and then having to say "yes, send it" is
   * one decision asked twice — and the chips are already the visible answer.
   * Dropping the last chip disarms it again.
   */
  useEffect(() => {
    if (!allowAnnotations) {
      setAnnotations(false);
      return;
    }
    setAnnotations(attachedCount > 0);
  }, [allowAnnotations, attachedCount]);

  const clearLongPress = useCallback(() => {
    const state = longPressRef.current;
    if (state.timer != null) clearTimeout(state.timer);
    if (state.armTimer != null) clearTimeout(state.armTimer);
    state.timer = null;
    state.armTimer = null;
    state.messageId = null;
    state.pointerId = null;
    state.moved = false;
    state.armed = false;
  }, []);

  const trackLongPressMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = longPressRef.current;
      if (state.timer == null || state.moved) return;
      if (state.pointerId != null && event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      /*
       * A finger resting on glass is never perfectly still.
       *
       * Only a deliberate scroll should cancel. Once armed (pointer captured),
       * swallow the move so the message list cannot steal the hold mid-gesture
       * — that is what made coach long-press feel broken on tablet.
       */
      if (state.armed) {
        event.preventDefault();
        return;
      }
      if (Math.abs(dy) > 16 || Math.abs(dx) > 24) {
        state.moved = true;
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const clearCopyAckTimer = useCallback(() => {
    if (copyAckTimerRef.current != null) {
      window.clearTimeout(copyAckTimerRef.current);
      copyAckTimerRef.current = null;
    }
  }, []);

  const openMessageMenu = useCallback(
    (messageId: string, anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      const chat = listRef.current?.getBoundingClientRect();
      const menuWidth = 120;
      const menuHeight = 36;
      const pad = 8;
      const leftBound = (panel?.left ?? 0) + pad;
      const rightBound = (panel?.right ?? window.innerWidth) - pad;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2, leftBound + menuWidth / 2),
        rightBound - menuWidth / 2,
      );
      // Prefer under the message; flip above when near the panel bottom.
      const bottomBound = (panel?.bottom ?? window.innerHeight) - pad;
      let top = rect.bottom + 8;
      if (top + menuHeight > bottomBound) {
        top = Math.max((panel?.top ?? pad) + pad, rect.top - menuHeight - 8);
      }
      const chatH = chat?.height ?? Math.max(200, window.innerHeight * 0.4);
      const tall = rect.height > chatH * 0.85;
      clearCopyAckTimer();
      setMessageMenu({ messageId, top, left, tall });
      setCopyFlash(false);
      setMenuFading(false);
    },
    [clearCopyAckTimer],
  );

  const closeMessageMenu = useCallback(() => {
    clearCopyAckTimer();
    setMessageMenu(null);
    setCopyFlash(false);
    setMenuFading(false);
    clearLongPress();
  }, [clearLongPress, clearCopyAckTimer]);

  const finishMarkMenuClose = useCallback(() => {
    setMarkMenuOpen(false);
    setMarkMenuClosing(false);
    setMarkMenuPos(null);
    setFootnoteMenuOpen(false);
    setFootnoteMenuClosing(false);
    setFootnoteMenuPos(null);
  }, []);

  const finishFootnoteMenuClose = useCallback(() => {
    setFootnoteMenuOpen(false);
    setFootnoteMenuClosing(false);
    setFootnoteMenuPos(null);
  }, []);

  const closeFootnoteMenu = useCallback(() => {
    setFootnoteMenuOpen((open) => {
      if (open) setFootnoteMenuClosing(true);
      return open;
    });
  }, []);

  const closeMarkMenu = useCallback(() => {
    setMarkMenuOpen((open) => {
      if (open) setMarkMenuClosing(true);
      return open;
    });
    setFootnoteMenuOpen((open) => {
      if (open) setFootnoteMenuClosing(true);
      return open;
    });
  }, []);

  useEffect(() => {
    if (!markMenuClosing) return;
    const id = window.setTimeout(finishMarkMenuClose, 200);
    return () => window.clearTimeout(id);
  }, [markMenuClosing, finishMarkMenuClose]);

  useEffect(() => {
    if (!footnoteMenuClosing || markMenuClosing) return;
    const id = window.setTimeout(finishFootnoteMenuClose, 200);
    return () => window.clearTimeout(id);
  }, [footnoteMenuClosing, markMenuClosing, finishFootnoteMenuClose]);

  useEffect(() => {
    if (!markMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (footnoteMenuOpen && !footnoteMenuClosing) {
        closeFootnoteMenu();
        return;
      }
      closeMarkMenu();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (markMenuClickShouldKeepOpen(event.target)) return;
      closeMarkMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [markMenuOpen, footnoteMenuOpen, footnoteMenuClosing, closeMarkMenu, closeFootnoteMenu]);

  const toggleMarkMenu = useCallback(() => {
    if (markMenuOpen && !markMenuClosing) {
      closeMarkMenu();
      return;
    }
    const node = annotateBtnRef.current;
    if (node) setMarkMenuPos(markMenuPosition(node.getBoundingClientRect()));
    setMarkMenuClosing(false);
    setFootnoteMenuOpen(false);
    setFootnoteMenuClosing(false);
    setFootnoteMenuPos(null);
    setMarkMenuOpen(true);
  }, [markMenuOpen, markMenuClosing, closeMarkMenu]);

  const toggleFootnoteMenu = useCallback(() => {
    if (footnoteMenuOpen && !footnoteMenuClosing) {
      closeFootnoteMenu();
      return;
    }
    setFootnoteMenuClosing(false);
    setFootnoteMenuOpen(true);
  }, [footnoteMenuOpen, footnoteMenuClosing, closeFootnoteMenu]);

  useLayoutEffect(() => {
    if (!markMenuOpen || markMenuClosing) return;
    let frame = 0;
    const place = () => {
      const node = annotateBtnRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return;
      const next = markMenuPosition(rect);
      setMarkMenuPos((current) =>
        current && current.left === next.left && current.bottom === next.bottom ? current : next,
      );
    };
    place();
    const kick = () => {
      place();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener("resize", kick);
    window.addEventListener("scroll", kick, true);
    const view = window.visualViewport;
    view?.addEventListener("resize", kick);
    view?.addEventListener("scroll", kick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", kick);
      window.removeEventListener("scroll", kick, true);
      view?.removeEventListener("resize", kick);
      view?.removeEventListener("scroll", kick);
    };
  }, [markMenuOpen, markMenuClosing]);

  useLayoutEffect(() => {
    if (!footnoteMenuOpen || markMenuClosing || !markMenuRef.current) return;
    const r = markMenuRef.current.getBoundingClientRect();
    const width = r.width || MARK_MENU_WIDTH_PX;
    const gap = 6;
    const menuCenter = r.left + width / 2;
    let side: "left" | "right" = menuCenter > window.innerWidth / 2 ? "left" : "right";
    if (side === "left" && r.left < width + gap + 8) side = "right";
    if (side === "right" && r.right + width + gap > window.innerWidth - 8) side = "left";
    setFootnoteMenuPos({
      top: r.top,
      width,
      height: r.height > 0 ? r.height : undefined,
      left: side === "right" ? r.right + gap : r.left - width - gap,
      side,
    });
  }, [footnoteMenuOpen, markMenuClosing, annotationChoices.length, markMenuPos?.left, markMenuPos?.bottom]);

  /**
   * Scroll a quoted turn back into view and flash it.
   *
   * The flash matters: on a long thread the original may land anywhere in the
   * viewport after the scroll, and without something to catch the eye the jump
   * reads as the panel having moved for no reason.
   */
  const jumpToMessage = useCallback((id: string) => {
    const list = listRef.current;
    const node = Array.from(list?.querySelectorAll<HTMLElement>("[data-coach-message]") ?? [])
      .find((entry) => entry.dataset.coachMessage === id);
    if (!node || !list) return;
    // scrollIntoView also scrolls the shell and body, stranding the translated
    // sheet and moving Home under Android's status bar on return from a thread.
    const target = list.scrollTop + node.getBoundingClientRect().top -
      list.getBoundingClientRect().top - (list.clientHeight - node.offsetHeight) / 2;
    list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    node.classList.add("is-flashed");
    window.setTimeout(() => node.classList.remove("is-flashed"), 1400);
  }, []);

  const clearMotionFallback = useCallback(() => {
    if (motionTimerRef.current != null) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = null;
    }
  }, []);

  const settleThreadMotionRef = useRef<() => void>(() => {});

  const armMotionFallback = useCallback(() => {
    clearMotionFallback();
    motionTimerRef.current = window.setTimeout(() => {
      settleThreadMotionRef.current();
    }, THREAD_MOTION_TIMEOUT_MS);
  }, [clearMotionFallback]);

  const settleThreadMotion = useCallback(() => {
    clearMotionFallback();
    setThreadMotion((phase) => {
      if (phase === "exit") {
        setOpenThreadId(null);
        setReplyTo(null);
        window.queueMicrotask(() => armMotionFallback());
        return "back";
      }
      return "idle";
    });
  }, [clearMotionFallback, armMotionFallback]);

  settleThreadMotionRef.current = settleThreadMotion;

  const enterThread = useCallback(
    (id: string) => {
      if (threadMotionRef.current === "exit") return;
      setOpenThreadId(id);
      setThreadMotion("enter");
      armMotionFallback();
    },
    [armMotionFallback],
  );

  const leaveThread = useCallback(() => {
    if (!openThreadId || threadMotionRef.current === "exit") return;
    exitedRootRef.current = openThreadId;
    setThreadMotion("exit");
    armMotionFallback();
  }, [openThreadId, armMotionFallback]);

  useEffect(() => () => clearMotionFallback(), [clearMotionFallback]);

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    if (openThreadId) {
      if (chatPinned.current) node.scrollTop = node.scrollHeight;
      return;
    }
    const returning = exitedRootRef.current;
    if (!returning) return;
    exitedRootRef.current = null;
    requestAnimationFrame(() => jumpToMessage(returning));
  }, [openThreadId, jumpToMessage]);

  /**
   * Stop an in-flight send and put its text back in the composer.
   *
   * Abort leaves the turn where it is, marked stopped. Edit does that and
   * also hands the words back, so the next Send is a revised copy rather
   * than a retry of the same request.
   */
  const editRunningMessage = (message: AgentChatMessage) => {
    onAbortMessage?.(message.id);
    setDraft(message.content);
    setReplyTo(message.replyTo ?? null);
    setChatFocus((current) => (current === "messages" ? "split" : current));
    closeMessageMenu();
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  };

  const quoteMessage = useCallback(
    (message: AgentChatMessage) => {
      const ref = replyRefFor(message);
      setReplyTo(ref);
      const root = messageThreadRoot(messages, message);
      let opening = false;
      setOpenThreadId((current) => {
        if (!current) opening = true;
        return current ?? root;
      });
      if (opening) {
        setThreadMotion("enter");
        armMotionFallback();
      }
      closeMessageMenu();
      onOpenChange?.(true);
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    },
    [closeMessageMenu, onOpenChange, messages, armMotionFallback],
  );

  const copyMessage = useCallback(
    async (message: AgentChatMessage) => {
      const ok = await copyToClipboard(message.content);
      if (!ok) return;
      setCopyFlash(true);
      setMenuFading(false);
      clearCopyAckTimer();
      copyAckTimerRef.current = window.setTimeout(() => {
        setMenuFading(true);
        copyAckTimerRef.current = window.setTimeout(() => {
          copyAckTimerRef.current = null;
          closeMessageMenu();
        }, COPY_FADE_MS);
      }, COPY_ACK_MS);
    },
    [clearCopyAckTimer, closeMessageMenu],
  );

  useEffect(() => () => {
    if (copyAckTimerRef.current != null) window.clearTimeout(copyAckTimerRef.current);
  }, []);

  useEffect(() => {
    const node = listRef.current;
    if (!node || !chatPinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature ignores frameIndex
    coachScrollSignature(messages),
    thinking,
    thinkingPhase,
    children,
    open,
  ]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  useEffect(() => {
    if (!messageMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMessageMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messageMenu, closeMessageMenu]);

  if (!open && !mobile && !keepPanel) {
    return <aside ref={panelRef} className="lc-side" id="lc-agent-panel" aria-label="Agent" aria-hidden="true" />;
  }

  const canSend =
    draft.trim().length > 0 ||
    draw ||
    reviewBoard ||
    lazy ||
    handwriting ||
    annotations ||
    photos.length > 0 ||
    // A quote on its own is a question: "what is this?".
    pageQuote != null;
  const menuMessage = messageMenu
    ? messages.find((message) => message.id === messageMenu.messageId)
    : undefined;
  const menuHasText = Boolean(menuMessage?.content.trim());

  const beginLongPress = (messageId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (isLongPressBlocked(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearLongPress();
    const node = event.currentTarget;
    const state = longPressRef.current;
    state.messageId = messageId;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.moved = false;
    state.armed = false;
    // After a short stillness, capture the pointer so the scroller cannot
    // cancel the hold with pointercancel before LONG_PRESS_MS.
    state.armTimer = window.setTimeout(() => {
      if (state.moved || state.messageId !== messageId) return;
      state.armed = true;
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        /* capture can fail if the pointer already ended */
      }
    }, SELECT_HOLD_ARM_MS);
    state.timer = window.setTimeout(() => {
      if (state.moved || state.messageId !== messageId) return;
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(10);
        }
      } catch {
        /* ignore */
      }
      suppressClickRef.current = true;
      openMessageMenu(messageId, node);
    }, LONG_PRESS_MS);
  };

  const submit = (mode: "queue" | "merge" = "queue", event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const sentDraft = draft, sentPhotos = photos, sentQuote = pageQuote;
    const sent = onSend(
      draft.trim(),
      {
        ask: askOnly || (!reviewBoard && !lazy && !draw),
        draw,
        reviewBoard,
        lazy,
        handwriting,
        reasoning,
        annotations: allowAnnotations && annotations,
        ...(photos.length > 0 ? { photos } : {}),
        ...(pageQuote ? { pageQuote: pageQuote.text, documentView: quoteSeed?.view } : {}),
        threadRootId: openThreadId,
        ...(replyTo ? { replyTo } : {}),
        ...(documentPresets && askPreset ? { askPreset } : {}),
      },
      mode,
    );
    void Promise.resolve(sent).then(ok => {
      if (ok !== false) return;
      setDraft(current => current ? `${sentDraft}\n\n${current}` : sentDraft);
      setPhotos(current => [...sentPhotos, ...current]);
      setPageQuote(current => current ?? sentQuote);
    });
    setReplyTo(null);
    setPageQuote(null);
    setDraft("");
    setDraw(false);
    setReviewBoard(false);
    setLazy(false);
    setHandwriting(false);
    setAnnotations(false);
    setAskPreset(null);
    setPhotos([]);
    setPhotoError(null);
    closeMessageMenu();
    closeMarkMenu();
  };

  const closeLightbox = () => {
    if (!lightbox || lightboxClosing) return;
    setLightboxClosing(true);
  };

  const onLightboxAnimEnd = () => {
    if (!lightboxClosing) return;
    setLightbox(null);
    setLightboxClosing(false);
  };

  return (
    <aside
      ref={panelRef}
      className={[
        "lc-side",
        "lc-side-open",
        mobile ? "lc-side-sheet" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      id="lc-agent-panel"
      aria-label="Agent"
      aria-hidden={!open}
    >
      {!mobile && open ? <AgentPanelSash /> : null}
      <div
        className="lc-agent-sheet-handle"
        role={mobile ? "button" : undefined}
        tabIndex={mobile ? 0 : -1}
        aria-expanded={mobile ? open : undefined}
        aria-label={mobile ? "Drag to resize agent; tap to hide" : undefined}
        title={mobile ? "Drag to resize; tap to hide" : undefined}
        onPointerDown={sheet.down}
        onPointerMove={sheet.move}
        onPointerUp={sheet.end}
        onPointerCancel={sheet.end}
        onLostPointerCapture={sheet.end}
        onKeyDown={mobile ? (event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(false); } }) : undefined}
      >
        <span className="lc-agent-fold-bar" aria-hidden />
      </div>
      <div className="lc-agent-pane-expand-row lc-agent-pane-expand-panel">
        <button
          type="button"
          className="lc-flag lc-agent-pane-expand lc-agent-panel-toggle"
          aria-pressed={!sessionsHidden}
          aria-label={sessionsHidden ? "Show sessions" : "Hide sessions"}
          title={sessionsHidden ? "Show sessions" : "Hide sessions"}
          onClick={() => setSessionsHidden((hidden) => !hidden)}
        >
          <svg className="lc-agent-pane-expand-icon" viewBox="0 0 16 16" aria-hidden>
            <rect
              x="2.25"
              y="2.75"
              width="11.5"
              height="10.5"
              rx="1.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.35"
            />
            <path
              d="M6.25 2.75v10.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.35"
            />
          </svg>
        </button>
        <PaneExpandButton
          pane="messages"
          focus={chatFocus}
          onToggle={toggleChatFocus}
        />
      </div>
      <div
        className={[
          "lc-agent-chat",
          openThreadId ? "is-threaded" : "",
          chatFocus === "split" ? "" : `is-focus-${chatFocus}`,
          threadMotion === "idle" ? "" : `lc-thread-motion-${threadMotion}`,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {openThreadId ? (
          <div className="lc-agent-thread-bar">
            <button
              type="button"
              className="lc-agent-thread-back"
              onClick={leaveThread}
            >
              ← Conversation
            </button>
            <span className="lc-agent-thread-title">
              Thread · {threadReplies.get(openThreadId)?.length ?? 0}{" "}
              {(threadReplies.get(openThreadId)?.length ?? 0) === 1 ? "reply" : "replies"}
            </span>
          </div>
        ) : null}
        <div className="lc-agent-messages-host has-sessions">
          <div className={`lc-agent-sessions-col${sessionsHidden ? " is-closed" : ""}`}>
            <div className="lc-agent-sessions-fade" aria-hidden />
            <nav className="lc-agent-sessions" aria-label="Sessions" aria-hidden={sessionsHidden || undefined}>
              {orderedSessions.length === 0 ? (
                <p className="lc-agent-sessions-empty">No sessions</p>
              ) : orderedSessions.map((session) => {
                const pinned = pinnedSessionIds.includes(session.id);
                return (
                <div
                  key={session.id}
                  data-status={session.status}
                  className={`lc-agent-session-row${session.id === activeSessionId ? " is-active" : ""}${pinned ? " is-pinned" : ""}`}
                >
                  <HoldButton
                    className={`lc-agent-session lc-hold-danger${session.id === activeSessionId ? " is-active" : ""}`}
                    label={session.title}
                    ariaLabel={`${session.title}. Tap to open, hold to delete`}
                    dataTip="Hold to delete"
                    dataTipPlacement="right"
                    holdMs={1200}
                    disabled={sessionsHidden}
                    onTap={() => setPickedSessionId(session.id)}
                    onConfirm={() => deleteSession(session.id)}
                  >
                    <span className="lc-agent-session-name">{session.title}</span>
                  </HoldButton>
                  <button
                    type="button"
                    className={`lc-agent-session-pin${pinned ? " is-pinned" : ""}`}
                    aria-pressed={pinned}
                    aria-label={pinned ? "Unpin session" : "Pin session"}
                    title={pinned ? "Unpin session" : "Pin session"}
                    tabIndex={sessionsHidden ? -1 : undefined}
                    onClick={() => toggleSessionPin(session.id)}
                  >
                    <svg className="lc-agent-session-pin-icon" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M6.1 1.6h3.8v2.8l1.5 1.5v1.3H9.2V14L8 12.7 6.8 14V7.2H4.6V5.9l1.5-1.5V1.6z"
                        fill={pinned ? "currentColor" : "none"}
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
                );
              })}
            </nav>
          </div>
        <div
          className="lc-agent-messages lc-scroll-pane"
          ref={listRef}
          key={openThreadId ?? "__room__"}
          aria-live="polite"
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            settleThreadMotion();
          }}
        >
          <div className="lc-agent-messages-anchor" aria-hidden />
          {sessions.length === 0 && !children && !thinking && (
            <p className="lc-muted lc-agent-empty">
              {padSurface && !allowAnnotations ? (
                <>
                  Ask about the board. Flag <strong>Handwriting</strong> to send
                  your ink with the page it was drawn on.
                </>
              ) : padSurface ? (
                <>
                  Ask about the page, or hold a passage to quote it. Flag{" "}
                  <strong>Annotation</strong> to send your marks — hold it to send just
                  the view you are on.
                </>
              ) : (
                <>
                  Ask a question with <strong>Ask</strong>, flag <strong>Review</strong> to
                  run a staged board review, or <strong>Draw</strong> to request a diagram.
                </>
              )}
            </p>
          )}
          {visibleMessages.map((message) => {
            if (isSavedAttachmentNotice(message)) {
              return (
                <span key={message.id} className="lc-artifact-save-notice" data-coach-message={message.id}>
                  {onOpenArtifact ? <ArtifactCards references={message.artifacts} onOpen={onOpenArtifact} /> : null}
                </span>
              );
            }
            const replyStub = message.replyTo;
            const replyCount = threadReplies.get(message.id)?.length ?? 0;
            return (
            <AgentMessageBubble
              key={message.id}
              enter={!seenMessages.current.has(message.id) && (message.role === "user" || message.role === "assistant")}
              data-coach-message={message.id}
              className={`lc-agent-turn lc-agent-turn-selectable lc-agent-turn-${turnKind(message.role)}${
                message.requestState === "failed" ? " lc-agent-turn-failed" : ""
              }${
                message.requestState === "cancelled" || message.requestState === "interrupted"
                  ? " lc-agent-turn-cancelled"
                  : ""
              }${
                messageMenu?.messageId === message.id
                  ? messageMenu.tall
                    ? " lc-agent-turn-selected lc-agent-turn-selected-tall"
                    : " lc-agent-turn-selected"
                  : ""
              }`}
              onContextMenu={(event) => {
                if (isLongPressBlocked(event.target)) return;
                event.preventDefault();
                openMessageMenu(message.id, event.currentTarget);
              }}
              onPointerDown={(event) => beginLongPress(message.id, event)}
              onPointerMove={trackLongPressMove}
              onPointerUp={clearLongPress}
              onPointerCancel={clearLongPress}
              onPointerLeave={(event) => {
                // Captured holds survive leave; only clear when not armed.
                if (!longPressRef.current.armed) clearLongPress();
                else if (
                  longPressRef.current.pointerId != null &&
                  event.pointerId !== longPressRef.current.pointerId
                ) {
                  clearLongPress();
                }
              }}
              onClickCapture={(event) => {
                if (!suppressClickRef.current) return;
                suppressClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="lc-agent-turn-head">
              <div className="lc-agent-turn-role-group">
              <div
                className={
                  message.role === "assistant" && message.review?.provider
                    ? "lc-agent-turn-role lc-tip-target"
                    : "lc-agent-turn-role"
                }
                data-tip={
                  message.role === "assistant" && message.review?.provider
                    ? message.review.provider
                    : undefined
                }
                data-tip-placement="right"
              >
                {ROLE_LABEL[message.role]}
              </div>
              </div>
              <MessageArtifactTools
                message={message}
                onSave={onSaveArtifact}
                onManage={onManageArtifacts}
              />
              </div>
              {message.retryOf && <small>Retry · previous attempt retained above</small>}
              {message.queued && (
                <span className="lc-agent-queued" aria-label="Queued message">Queued</span>
              )}
              <AgentTurnResponse pending={Boolean(message.pending)} events={message.processEvents}
                showProcess={showProcess}
                displayPrefs={displayPrefs} disclosure={disclosureFor(message.id)}
                reasoning={message.reasoning}
                text={turnBody(message)}
                assistant={message.role === "assistant"}>
              {showsReplyStub(message, openThreadId) && (
                /*
                 * The quoted turn, above the reply that answers it.
                 *
                 * Clicking it scrolls to the original and flashes it, which is
                 * the whole point of keeping a reference rather than a copy:
                 * the thread is navigable in both directions instead of being
                 * prose that happens to mention what came before.
                 */
                <button
                  type="button"
                  className="lc-agent-reply-stub"
                  title={`Go to ${ROLE_LABEL[replyStub!.role]}'s message`}
                  onClick={(event) => {
                    event.stopPropagation();
                    jumpToMessage(replyStub!.id);
                  }}
                >
                  <span className="lc-agent-reply-stub-role">
                    {ROLE_LABEL[replyStub!.role]}
                  </span>
                  <span className="lc-agent-reply-stub-text">{replyStub!.excerpt}</span>
                </button>
              )}
              {offerDrawFor(message, visibleMessages) && (
                <button
                  type="button"
                  className="lc-agent-draw-offer"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSend("Draw a diagram of what you just explained.", {
                      ask: true,
                      draw: true,
                      reviewBoard: false,
                      lazy: false,
                      handwriting: false,
                      annotations: false,
                      reasoning,
                      replyTo: { id: message.id, role: "assistant", excerpt: replyExcerpt(message.content) },
                    });
                  }}
                >
                  Draw this
                </button>
              )}
              </AgentTurnResponse>
              {!openThreadId && replyCount > 0 && (
                /*
                 * The thread, collapsed to one line.
                 *
                 * Replies used to sit in the transcript as ordinary turns, so a
                 * message with three answers put three of them between you and
                 * whatever was said next, each carrying its own stub of the
                 * same quote. One bubble instead, and the back-and-forth lives
                 * behind it — including a single Agent answer hung off a mark
                 * Ask (`replyTo`), which must not also render as a room turn.
                 */
                <button
                  type="button"
                  className="lc-agent-thread-open"
                  aria-label={`Open thread, ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    enterThread(message.id);
                  }}
                >
                  <span className="lc-agent-thread-open-peek">
                    {threadReplies.get(message.id)!.at(-1)?.content.slice(0, 60) ||
                      (threadReplies.get(message.id)!.at(-1)?.pending
                        ? "Working…"
                        : "")}
                  </span>
                  <span className="lc-agent-thread-open-count">
                    {replyCount} {replyCount === 1 ? "reply" : "replies"}
                  </span>
                </button>
              )}
              {message.attachments && message.attachments.length > 0 && (
                <div className="lc-agent-attachments" aria-label="Attached layouts">
                  {message.attachments.map((att) => (
                    <figure key={att.label} className="lc-agent-thumb">
                      <button
                        type="button"
                        className="lc-agent-thumb-btn"
                        onClick={() => {
                          setLightboxClosing(false);
                          setLightbox(att);
                        }}
                        aria-label={`Open ${att.label}`}
                      >
                        <img
                          src={`data:image/png;base64,${att.thumb ?? att.png}`}
                          alt={att.label}
                          title={att.label}
                        />
                      </button>
                      <figcaption>{att.label}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {message.review && (
                <div className="lc-agent-review-embed">
                  <ReviewPanel
                    review={message.review}
                    onRequestBridge={() => onRequestBridge?.(message.id)}
                    onDismiss={() => {
                      /* kept in history — dismiss is a no-op; card stays for the turn */
                    }}
                    compact
                    bridgeOffered={Boolean(message.bridge) || Boolean(message.bridgePending)}
                  />
                </div>
              )}
              {message.bridgePending && (
                <div className="lc-bridge-pending" role="status">
                  <span className="lc-reveal-loading-ring" aria-hidden />
                  <div>
                    <strong>Building the bridge…</strong>
                    <p className="lc-muted">Tracing a path from your approach to a working one.</p>
                  </div>
                </div>
              )}
              {message.bridgeError && !message.bridgePending && (
                <p className="lc-warning">{message.bridgeError}</p>
              )}
              {message.bridge && !message.bridgePending && (
                <BridgePanel bridge={message.bridge} compact collapsible defaultOpen />
              )}
              {message.drawing && (
                <DrawingSection
                  drawing={message.drawing}
                  onToggle={(expanded) => onToggleDrawing?.(message.id, expanded)}
                  onFrame={(frameIndex) =>
                    onDrawingFrame?.(message.drawing!.program.id, frameIndex)
                  }
                />
              )}
              {onOpenArtifact && <ArtifactCards references={message.artifacts} onOpen={onOpenArtifact} />}
              {onSaveArtifact && message.artifactProposals && message.artifactProposals.length > 0 && (
                <div className="lc-agent-proposal-saves">
                  {message.artifactProposals.map((proposal, index) => (
                    <button
                      type="button"
                      className="lc-secondary lc-agent-proposal-save"
                      key={`${proposal.title}-${index}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSaveArtifact(message, proposal, index);
                      }}
                    >
                      Save {proposal.title}
                    </button>
                  ))}
                </div>
              )}
              <MessageFlags message={message} />
            </AgentMessageBubble>
            );
          })}
          {children}
          {thinking && !visibleMessages.some((message) => message.pending) && (
            <div className="lc-agent-turn lc-agent-turn-assistant lc-agent-thinking" role="status">
              <div className="lc-agent-turn-role">Agent</div>
              <div className="lc-agent-turn-body">
                <span className="lc-agent-spinner" aria-hidden />
                {thinkingPhase?.trim() || "Thinking…"}
              </div>
            </div>
          )}
        </div>
        </div>

        {error?.trim() ? (
          <p className="lc-agent-panel-error" role="alert">
            {error.trim()}
          </p>
        ) : null}

        {editingQueued && <div role="dialog" aria-label="Edit queued message">
          <textarea aria-label="Queued question" value={queueEditText} onChange={e => setQueueEditText(e.target.value)} />
          <button type="button" disabled={!queueEditText.trim()} onClick={() => {
            onEditMessage?.(editingQueued.id, queueEditText.trim()); setEditingQueued(null);
          }}>Save queued question</button>
          <button type="button" onClick={() => { onCancelEdit?.(editingQueued.id); setEditingQueued(null); }}>Cancel edit</button>
        </div>}
        <form className="lc-agent-composer" inert={chatFocus === "messages"} aria-hidden={chatFocus === "messages" || undefined} onSubmit={(event) => submit("queue", event)}>
          <div className="lc-agent-composer-clip">
          <div className="lc-agent-composer-body">
          {allowAnnotations && attachedMarks.length > 0 && (
            <>
            <div className="lc-agent-mark-chips" aria-label="Attached annotations">
              {attachedMarks.map((mark) => {
                const overflow = Boolean(askPackPreview?.omittedMarkIds.includes(mark.id));
                const chipLabel = footnoteChipLabel(mark.number, mark.title);
                return (
                <HoldButton
                  key={mark.id}
                  className={`lc-footnote-chip lc-hold-danger${overflow ? " is-overflow" : ""}`}
                  label={chipLabel}
                  ariaLabel={`Hold to remove ${chipLabel}`}
                  style={footnoteThemeVars(mark.color, mark.palette ?? [])}
                  dataTip={
                    overflow
                      ? "Will not be sent — this Ask is full. Hold to remove."
                      : "Hold to remove"
                  }
                  dataTipPlacement="top"
                  disabled={!onRemoveAttached}
                  onConfirm={() => onRemoveAttached?.(mark.id)}
                >
                  <span className="lc-fn-badge" aria-hidden>
                    {mark.number ?? ""}
                  </span>
                  {mark.title?.trim() ? (
                    <span className="lc-footnote-chip-label">{mark.title.trim()}</span>
                  ) : null}
                </HoldButton>
                );
              })}
            </div>
            {askPackPreview &&
              (askPackPreview.omittedMarkIds.length > 0 || askPackPreview.questionTruncated) && (
                <p className="lc-agent-mark-fit">
                  {askPackPreview.questionTruncated
                    ? "The question will be truncated for the model."
                    : null}
                  {askPackPreview.questionTruncated && askPackPreview.omittedMarkIds.length > 0
                    ? " "
                    : null}
                  {askPackPreview.omittedMarkIds.length > 0
                    ? `Only ${askPackPreview.includedMarkIds.length} of ${attachedMarks.length} marks fit this Ask. The rest stay on the page.`
                    : null}
                </p>
              )}
            </>
          )}
          {pageQuote && (
            <div className="lc-agent-reply-chip lc-agent-quote-chip">
              <span className="lc-agent-reply-chip-mark" aria-hidden />
              <div className="lc-agent-reply-chip-text">
                <span className="lc-agent-reply-stub-role">Quoting the page</span>
                <span className="lc-agent-reply-stub-text">{pageQuote.excerpt}</span>
              </div>
              <button
                type="button"
                className="lc-agent-reply-chip-clear"
                aria-label="Drop the quote"
                title="Drop the quote"
                onClick={() => setPageQuote(null)}
              >
                ×
              </button>
            </div>
          )}
          {replyTo && (
            <div className="lc-agent-reply-chip">
              <span className="lc-agent-reply-chip-mark" aria-hidden />
              <div className="lc-agent-reply-chip-text">
                <span className="lc-agent-reply-stub-role">
                  Replying to {ROLE_LABEL[replyTo.role]}
                </span>
                <span className="lc-agent-reply-stub-text">{replyTo.excerpt}</span>
              </div>
              <button
                type="button"
                className="lc-agent-reply-chip-clear"
                aria-label="Cancel reply"
                title="Cancel reply"
                onClick={() => setReplyTo(null)}
              >
                ×
              </button>
            </div>
          )}
          {/*
            Staged photos sit above the textarea, not beside Send: they are part
            of the message being written, and an attachment you cannot see is an
            attachment you forget you made. Each is removable until it is sent.
          */}
          {photos.length > 0 && (
            <div className="lc-agent-photo-tray" aria-label="Attached photos">
              {photos.map((photo, index) => (
                <div className="lc-agent-photo-chip" key={`${photo.label}-${index}`}>
                  <img
                    src={`data:image/png;base64,${photo.thumb ?? photo.png}`}
                    alt={photo.label}
                  />
                  <button
                    type="button"
                    className="lc-agent-photo-chip-clear"
                    aria-label={`Remove ${photo.label}`}
                    onClick={() =>
                      setPhotos((current) => current.filter((_, at) => at !== index))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {photoError && <p className="lc-warning">{photoError}</p>}
          <div className="lc-agent-composer-field">
          <textarea
            ref={composerRef}
            value={draft}
            rows={10}
            placeholder="Ask the agent about your board or code…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.shiftKey) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) submit("merge");
              else submit("queue");
            }}
          />
          <div className="lc-agent-composer-bar">
            {/* Ambient stays greyed until AMBIENT_ENABLED is flipped. The
                socket + 120s loop are already wired in App / coachSocket. */}
            {!padSurface && (
            <div className="lc-modes" role="group" aria-label="Agent mode">
              <Tip tip="Analyze on send" placement="top" flip={["top", "right"]}>
                <button
                  type="button"
                  className={mode === "review" ? "lc-mode lc-mode-active" : "lc-mode"}
                  aria-pressed={mode === "review"}
                  disabled={busy}
                  onClick={() => onModeChange("review")}
                  aria-label="On ask"
                >
                  <span className="lc-label-long">On ask</span>
                  <span className="lc-label-short" aria-hidden>
                    O
                  </span>
                </button>
              </Tip>
              <Tip
                tip={
                  AMBIENT_ENABLED
                    ? "Nudge every ~2 minutes when the board changes"
                    : "Ambient is off — agent answers when you ask"
                }
                placement="right"
              >
                <button
                  type="button"
                  className={
                    AMBIENT_ENABLED && mode === "ambient"
                      ? "lc-mode lc-mode-active"
                      : "lc-mode"
                  }
                  aria-pressed={AMBIENT_ENABLED && mode === "ambient"}
                  aria-disabled={!AMBIENT_ENABLED}
                  disabled={!AMBIENT_ENABLED || busy}
                  onClick={() => AMBIENT_ENABLED && onModeChange("ambient")}
                  aria-label="Every 2m"
                >
                  <span className="lc-label-long">Every 2m</span>
                  <span className="lc-label-short" aria-hidden>
                    E
                  </span>
                </button>
              </Tip>
            </div>
            )}
            <div className="lc-agent-composer-mid">
              <PaneExpandButton
                pane="composer"
                focus={chatFocus}
                onToggle={toggleChatFocus}
              />
              <span className="lc-agent-annotate-wrap">
                <Tip tip="Choose ink, footnotes and agent options" placement="top">
                  <button
                    ref={annotateBtnRef}
                    type="button"
                    className={`lc-flag lc-agent-annotate${handwriting || annotations ? " lc-flag-active" : ""}`}
                    aria-expanded={markMenuOpen && !markMenuClosing}
                    aria-haspopup="menu"
                    onClick={toggleMarkMenu}
                    aria-label="Annotations"
                  >
                    <InkScribbleIcon />
                  </button>
                </Tip>
              </span>
              {onManageArtifacts && (
                <Tip tip="Whiteboards and files" placement="top">
                  <button
                    type="button"
                    className="lc-flag lc-agent-catalog"
                    aria-label="Whiteboards and files"
                    onClick={() => onManageArtifacts()}
                  >
                    C
                  </button>
                </Tip>
              )}
            </div>
            <div className="lc-agent-composer-actions">
              <Tip
                tip={
                  reviewBoard
                    ? REVIEW_DROPS_PHOTOS
                    : photos.length >= PHOTO_ATTACH_LIMIT
                      ? `At most ${PHOTO_ATTACH_LIMIT} photos per message`
                      : "Attach a photo — gallery or camera"
                }
                placement="left"
              >
                <button
                  type="button"
                  className="lc-flag lc-agent-attach"
                  aria-label="Add Photo"
                  disabled={
                    picking || reviewBoard || photos.length >= PHOTO_ATTACH_LIMIT
                  }
                  onClick={() => {
                    setPhotoError(null);
                    setPicking(true);
                    void pickPhotos(PHOTO_ATTACH_LIMIT - photos.length)
                      .then((picked) => {
                        if (picked.length === 0) return;
                        setPhotos((current) =>
                          [
                            ...current,
                            ...picked.map((photo) => ({
                              label: photo.name,
                              png: photo.png,
                              thumb: photo.thumb,
                            })),
                          ].slice(0, PHOTO_ATTACH_LIMIT),
                        );
                      })
                      .catch((cause: unknown) =>
                        setPhotoError(
                          cause instanceof Error ? cause.message : String(cause),
                        ),
                      )
                      .finally(() => setPicking(false));
                  }}
                >
                  <PlusIcon />
                </button>
              </Tip>
              <button type="submit" className="lc-agent-send" disabled={!canSend} aria-label="Send">
                <SendIcon />
              </button>
            </div>
          </div>
          </div>
          </div>
          </div>
        </form>
      </div>

      {messageMenu &&
        menuMessage &&
        createPortal(
          <>
            <button
              type="button"
              className="lc-agent-message-menu-backdrop"
              aria-label="Dismiss message actions"
              onClick={closeMessageMenu}
            />
            <div
              className={`lc-agent-message-menu${copyFlash ? " is-copied" : ""}${menuFading ? " is-closing" : ""}`}
              role="menu"
              style={{ top: messageMenu.top, left: messageMenu.left }}
              onClick={(event) => event.stopPropagation()}
            >
              {menuMessage.role === "user" && menuMessage.requestState && <>
                {["preparing", "queued", "running"].includes(menuMessage.requestState) ?
                  <button role="menuitem" onClick={() => { onAbortMessage?.(menuMessage.id); closeMessageMenu(); }}>Abort</button> :
                  <button role="menuitem" onClick={() => { onRetryMessage?.(menuMessage.requestId ?? menuMessage.id); closeMessageMenu(); }}>Retry</button>}
                {["preparing", "queued", "running"].includes(menuMessage.requestState) && <button role="menuitem" onClick={() => {
                  if (menuMessage.requestState === "queued") {
                    if (onEditMessage?.(menuMessage.id)) { setEditingQueued(menuMessage); setQueueEditText(menuMessage.content); closeMessageMenu(); }
                    return;
                  }
                  editRunningMessage(menuMessage);
                }}>Edit</button>}
              </>}
              <button
                type="button"
                role="menuitem"
                data-copy=""
                disabled={!menuHasText}
                onClick={() => void copyMessage(menuMessage)}
              >
                {copyFlash ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!menuHasText}
                onClick={() => quoteMessage(menuMessage)}
              >
                Quote
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { onDeleteMessage?.(menuMessage.id); closeMessageMenu(); }}
              >
                Delete
              </button>
            </div>
          </>,
          document.body,
        )}

      {(markMenuOpen || markMenuClosing) &&
        markMenuPos &&
        createPortal(
          <>
            <div
              ref={markMenuRef}
              className={`lc-agent-scope-menu lc-agent-mark-menu${markMenuClosing ? " is-closing" : ""}`}
              role="menu"
              aria-label="Annotations and agent options"
              style={{
                left: markMenuPos.left,
                bottom: markMenuPos.bottom,
                width: MARK_MENU_WIDTH_PX,
                maxHeight: `calc(100dvh - ${markMenuPos.bottom + 12}px)`,
              }}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return;
                if (markMenuClosing) finishMarkMenuClose();
              }}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="Ink"
                aria-checked={handwriting}
                className={`lc-agent-scope-option lc-agent-option-row${handwriting ? " is-active" : ""}`}
                title="Attach marked-board ink crops with the next message"
                disabled={annotateUnavailable}
                onClick={() => setHandwriting(current => !current)}
              >
                <span>Ink</span><span>{handwriting ? "Enabled" : "Disabled"}</span>
              </button>
              {allowAnnotations && annotationChoices.length > 0 && <>
              <div role="separator" className="lc-agent-options-divider" />
              <button
                type="button"
                role="menuitem"
                className={`lc-agent-scope-option lc-agent-option-row${
                  (footnoteMenuOpen && !footnoteMenuClosing) || attachedMarks.length > 0
                    ? " is-active"
                    : ""
                }`}
                aria-label="Footnotes"
                aria-haspopup="menu"
                aria-expanded={footnoteMenuOpen && !footnoteMenuClosing}
                disabled={annotateUnavailable}
                onClick={toggleFootnoteMenu}
              >
                <span>Footnotes</span>
                <span>{attachedMarks.length > 0 ? attachedMarks.length : ""}</span>
              </button>
              </>}
              <div role="separator" className="lc-agent-options-divider" />
              <button
                type="button"
                role="menuitem"
                className="lc-agent-scope-option lc-agent-option-row"
                aria-label={`Action: ${boardLabel}`}
                title={padSurface ? "Tap to cycle Draw, Ask" : "Tap to cycle Draw, Review, Lazy, Ask"}
                disabled={askOnly && !padSurface}
                onClick={cycleBoard}
              >
                <span>Action</span><span>{boardLabel}</span>
              </button>
              {documentPresets && <>
                <div role="separator" className="lc-agent-options-divider" />
                <div role="group" aria-label="Ask presets" className="lc-agent-options-presets">
                  {ASK_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={askPreset === preset.id}
                      className={`lc-agent-scope-option${askPreset === preset.id ? " is-active" : ""}`}
                      onClick={() => setAskPreset(current => current === preset.id ? null : preset.id)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </>}
              <div role="separator" className="lc-agent-options-divider" />
              <button
                type="button"
                role="menuitem"
                className={`lc-agent-scope-option lc-agent-option-row${reasoning !== "off" ? " is-active" : ""}`}
                aria-label={`Reasoning: ${reasoning}`}
                title="Tap to cycle Off, Low, Medium, High"
                onClick={() => setReasoning(current => {
                  const next = cycleAgentReasoning(current);
                  saveAgentReasoningLevel(next);
                  return next;
                })}
              >
                <span>Reasoning</span><span>{reasoning[0].toUpperCase() + reasoning.slice(1)}</span>
              </button>
            </div>
            {(footnoteMenuOpen || footnoteMenuClosing) && footnoteMenuPos && (
              <div
                className={`lc-agent-scope-menu lc-agent-footnote-menu is-side-${footnoteMenuPos.side}${
                  footnoteMenuClosing ? " is-closing" : ""
                }`}
                role="menu"
                aria-label="Page footnotes"
                style={{
                  left: footnoteMenuPos.left,
                  top: footnoteMenuPos.top,
                  width: footnoteMenuPos.width,
                  height: footnoteMenuPos.height,
                }}
                onAnimationEnd={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (footnoteMenuClosing && !markMenuClosing) finishFootnoteMenuClose();
                }}
              >
                {annotationChoices.map((mark) => {
                  const picked = attachedMarks.some((entry) => entry.id === mark.id);
                  const chipLabel = footnoteChipLabel(mark.number, mark.title);
                  return (
                    <button
                      key={mark.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={picked}
                      aria-label={chipLabel}
                      disabled={annotateUnavailable}
                      className={`lc-footnote-chip${picked ? " is-picked" : ""}`}
                      style={footnoteThemeVars(mark.color, mark.palette ?? [])}
                      onClick={() => onToggleAttached?.(mark.id)}
                    >
                      <span className="lc-fn-badge" aria-hidden>
                        {mark.number ?? ""}
                      </span>
                      {mark.title?.trim() ? (
                        <span className="lc-footnote-chip-label">{mark.title.trim()}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </>,
          document.body,
        )}

      {lightbox && (
        <div
          className={
            lightboxClosing ? "lc-lightbox lc-lightbox-closing" : "lc-lightbox"
          }
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.label}
          onClick={closeLightbox}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            onLightboxAnimEnd();
          }}
        >
          <figure
            className="lc-lightbox-frame"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={`data:image/png;base64,${lightbox.png}`}
              alt={lightbox.label}
            />
            <figcaption>{lightbox.label}</figcaption>
          </figure>
        </div>
      )}
    </aside>
  );
}

/** Local ack while waiting for the daemon's `received` stage or the answer. */
export function pendingAckLine(message: AgentChatMessage): string {
  const ack = message.pendingAck;
  if (!ack) return "Working…";
  const inputs: string[] = [];
  if (ack.hasQuestion) inputs.push("question");
  if (ack.boardAttached) inputs.push("board");
  if (ack.photoCount > 0) {
    inputs.push(ack.photoCount === 1 ? "1 photo" : `${ack.photoCount} photos`);
  }
  const inputPart =
    inputs.length > 0 ? `got ${inputs.join(" + ")}` : "got your message";
  if (ack.flags.length > 0) return `${ack.flags.join(", ")} — ${inputPart}`;
  return inputPart;
}

function MessageArtifactTools({
  message,
  onSave,
  onManage,
}: {
  message: AgentChatMessage;
  onSave?: AgentSidePanelProps["onSaveArtifact"];
  onManage?: AgentSidePanelProps["onManageArtifacts"];
}) {
  const show =
    (message.role === "user" || message.role === "assistant") &&
    !message.pending &&
    !message.queued;
  if (!show || (!onSave && !onManage)) return null;
  const saveLabel = saveTurnLabel(message);
  return (
    <div className="lc-agent-turn-tools">
      {onSave && (
        <Tip tip={saveLabel} placement="top">
          <button
            type="button"
            className="lc-agent-turn-tool"
            aria-label={saveLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSave(message, turnArtifactProposal(message));
            }}
          >
            <SaveIcon />
          </button>
        </Tip>
      )}
      {onManage && (
        <Tip tip="Attachments" placement="top">
          <button
            type="button"
            className="lc-agent-turn-tool"
            aria-label="Attachments"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onManage(message);
            }}
          >
            <PaperclipIcon />
          </button>
        </Tip>
      )}
    </div>
  );
}

function MessageFlags({ message }: { message: AgentChatMessage }) {
  const pending = Boolean(message.pending);
  const failed = message.requestState === "failed";
  const cancelled = message.requestState === "cancelled" || message.requestState === "interrupted";
  const running = message.requestState === "running";
  const completed = message.requestState === "completed";
  const marked = failed || cancelled || running || completed;
  const flags = pending ? message.pendingAck?.flags ?? message.flags : message.flags;
  const text = flags?.join(" · ") || (pending ? "Working…" : "");
  const shown = useWordReveal(text, pending, pending);
  const tip = statusTip(message);
  if (!text && !marked) return null;
  return (
    <div
      className={`lc-agent-turn-footnotes${failed ? " is-failed" : ""}${cancelled ? " is-cancelled" : ""}${running ? " is-running" : ""}${completed ? " is-completed" : ""}`}
      role={pending || running ? "status" : undefined}
    >
      {marked ? (
        <span
          className="lc-agent-turn-fail lc-tip-target"
          aria-label={tip ?? undefined}
          data-tip={tip ?? undefined}
          data-tip-placement="top"
        >
          {running || completed ? <RunMark done={completed} /> : cancelled ? <StopIcon /> : <FailIcon />}
        </span>
      ) : (
        <span className="lc-agent-turn-flag-rule" aria-hidden />
      )}
      {text ? (
        <div
          className="lc-agent-turn-flags"
          aria-label={pending ? "Agent request" : "Send flags"}
          aria-busy={shown !== text}
        >
          <span className="lc-agent-turn-flag lc-agent-turn-flag-stream">{shown}</span>
        </div>
      ) : null}
    </div>
  );
}

function DrawingSection({
  drawing,
  onToggle,
  onFrame,
}: {
  drawing: MessageDrawing;
  onToggle: (expanded: boolean) => void;
  onFrame: (frameIndex: number) => void;
}) {
  const title = drawingHeading(drawing.program, drawing.frameIndex ?? 0);
  const expanded = drawing.expanded && !drawing.redacted;

  return (
    <div className="lc-agent-drawing">
      <button
        type="button"
        className="lc-agent-drawing-toggle"
        aria-expanded={expanded}
        onClick={() => onToggle(!drawing.expanded || Boolean(drawing.redacted))}
      >
        <span className="lc-agent-drawing-chevron" aria-hidden>▸</span>
        <span className="lc-agent-drawing-label">
          {drawing.redacted && !drawing.expanded ? "[redacted] " : ""}
          Drawing
        </span>
        <span className="lc-muted lc-agent-drawing-title">{title}</span>
        <span className="lc-agent-drawing-visibility">{expanded ? "On page" : "Hidden"}</span>
      </button>
      <AnimatedDisclosure open={expanded}>
        <div className="lc-agent-drawing-body">
          <DrawingPreview
            program={drawing.program}
            frameIndex={drawing.frameIndex ?? 0}
            title={title}
          />
          <Timeline
            program={drawing.program}
            initialFrame={drawing.frameIndex ?? 0}
            onFrame={onFrame}
          />
        </div>
      </AnimatedDisclosure>
    </div>
  );
}
