/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Draw / Review board are composer flags that ride along with Send, not
 * standalone actions. Structured results (review, tests, nudges) render
 * inside the message list as assistant turns.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { BridgeResponse, ReviewResponse } from "../api/types";
import { Tip } from "../components/Tip";
import type { MessageDrawing } from "../viz/drawingState";
import { Timeline } from "../viz/Timeline";
import { BridgePanel } from "./RevealDialog";
import { ReviewPanel } from "./ReviewPanel";

export type CoachMode = "review" | "ambient";

/**
 * The ambient coach polls the board every 120 seconds. Kept off until the
 * rest of the app is solid: on a slowly changing board it re-asked the same
 * question, and on a local model it blocked the pen while thinking. Flip this
 * to `true` to enable — `App` already wires the socket, probe/capture, and
 * nudge UI; this flag is the only gate.
 */
export const AMBIENT_ENABLED = false;

const ROLE_LABEL: Record<CoachChatMessage["role"], string> = {
  user: "You",
  assistant: "Coach",
  system: "System",
  app: "Tests",
};

function turnKind(role: CoachChatMessage["role"]): string {
  return role === "user" || role === "system" || role === "app" ? role : "assistant";
}

export interface CoachSendFlags {
  /** Ask the coach to draw on the board. */
  draw: boolean;
  /** Attach the current board (and code dock) to the request. */
  reviewBoard: boolean;
}

export interface CoachAttachment {
  label: string;
  /** Raw base64 PNG (no data: prefix). */
  png: string;
}

export interface CoachChatMessage {
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
  /** Coach diagram — expand/collapse controls board visibility. */
  drawing?: MessageDrawing;
}

export interface AgentSidePanelProps {
  open: boolean;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  busy: boolean;
  thinking?: boolean;
  /** Phased status while the local model works (replaces a bare "Thinking…"). */
  thinkingPhase?: string | null;
  messages: CoachChatMessage[];
  onSend: (text: string, flags: CoachSendFlags) => void;
  /** Opens the hold-to-reveal dialog for the review on this message. */
  onRequestBridge?: (messageId: string) => void;
  /** Expand/collapse a message's drawing section (and sync the board). */
  onToggleDrawing?: (messageId: string, expanded: boolean) => void;
  /** Scrub a multi-frame drawing that is currently expanded. */
  onDrawingFrame?: (programId: string, frameIndex: number) => void;
  /** Structured cards (tests, ambient, …) rendered in the thread. */
  children?: ReactNode;
}

export function AgentSidePanel({
  open,
  mode,
  onModeChange,
  busy,
  thinking = false,
  thinkingPhase = null,
  messages,
  onSend,
  onRequestBridge,
  onToggleDrawing,
  onDrawingFrame,
  children,
}: AgentSidePanelProps) {
  const [draft, setDraft] = useState("");
  const [draw, setDraw] = useState(false);
  const [reviewBoard, setReviewBoard] = useState(false);
  const [lightbox, setLightbox] = useState<CoachAttachment | null>(null);
  const [lightboxClosing, setLightboxClosing] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, thinking, thinkingPhase, children, open]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  if (!open) return null;

  const canSend = !busy && (draft.trim().length > 0 || draw || reviewBoard);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(draft.trim(), { draw, reviewBoard });
    setDraft("");
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
    <aside className="lc-side lc-side-open" id="lc-coach-panel" aria-label="Coach">
      <div className="lc-coach-chat">
        <div className="lc-coach-messages" ref={listRef} aria-live="polite">
          {messages.length === 0 && !children && !thinking && (
            <p className="lc-muted lc-coach-empty">
              Ask a question, optionally flag <strong>Review board</strong> to attach your
              sketch/code, or <strong>Draw</strong> to request a diagram.
            </p>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`lc-coach-turn lc-coach-turn-${turnKind(message.role)}`}
            >
              <div
                className={
                  message.role === "assistant" && message.review?.provider
                    ? "lc-coach-turn-role lc-tip-target"
                    : "lc-coach-turn-role"
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
              {message.content ? (
                <div className="lc-coach-turn-body">{message.content}</div>
              ) : null}
              {message.attachments && message.attachments.length > 0 && (
                <div className="lc-coach-attachments" aria-label="Attached layouts">
                  {message.attachments.map((att) => (
                    <figure key={att.label} className="lc-coach-thumb">
                      <button
                        type="button"
                        className="lc-coach-thumb-btn"
                        onClick={() => {
                          setLightboxClosing(false);
                          setLightbox(att);
                        }}
                        aria-label={`Open ${att.label}`}
                      >
                        <img
                          src={`data:image/png;base64,${att.png}`}
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
                <div className="lc-coach-review-embed">
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
            </div>
          ))}
          {children}
          {thinking && (
            <div className="lc-coach-turn lc-coach-turn-assistant lc-coach-thinking" role="status">
              <div className="lc-coach-turn-role">Coach</div>
              <div className="lc-coach-turn-body">
                <span className="lc-coach-spinner" aria-hidden />
                {thinkingPhase?.trim() || "Thinking…"}
              </div>
            </div>
          )}
        </div>

        <form className="lc-coach-composer" onSubmit={submit}>
          <textarea
            value={draft}
            rows={3}
            placeholder="Ask the coach about your board or code…"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="lc-coach-composer-bar">
            {/* Ambient stays greyed until AMBIENT_ENABLED is flipped. The
                socket + 120s loop are already wired in App / coachSocket. */}
            <div className="lc-modes" role="group" aria-label="Coach mode">
              <Tip tip="Analyze on send" placement="right">
                <button
                  type="button"
                  className={mode === "review" ? "lc-mode lc-mode-active" : "lc-mode"}
                  aria-pressed={mode === "review"}
                  disabled={busy}
                  onClick={() => onModeChange("review")}
                >
                  On ask
                </button>
              </Tip>
              <Tip
                tip={
                  AMBIENT_ENABLED
                    ? "Nudge every ~2 minutes when the board changes"
                    : "Ambient is off — coach answers when you ask"
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
                >
                  Every 2m
                </button>
              </Tip>
            </div>
            <div className="lc-coach-composer-actions">
              <Tip tip="Allow coach to draw on the board" placement="left">
                <button
                  type="button"
                  className={draw ? "lc-flag lc-flag-active" : "lc-flag"}
                  aria-pressed={draw}
                  disabled={busy}
                  onClick={() => setDraw((current) => !current)}
                >
                  Draw
                </button>
              </Tip>
              <Tip tip="Allow coach to review the board" placement="left">
                <button
                  type="button"
                  className={reviewBoard ? "lc-flag lc-flag-active" : "lc-flag"}
                  aria-pressed={reviewBoard}
                  disabled={busy}
                  onClick={() => setReviewBoard((current) => !current)}
                >
                  Review board
                </button>
              </Tip>
              <button type="submit" disabled={!canSend}>
                Send
              </button>
            </div>
          </div>
        </form>
      </div>

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

function DrawingSection({
  drawing,
  onToggle,
  onFrame,
}: {
  drawing: MessageDrawing;
  onToggle: (expanded: boolean) => void;
  onFrame: (frameIndex: number) => void;
}) {
  const title = drawing.program.title || drawing.program.id || "Drawing";
  const expanded = drawing.expanded && !drawing.redacted;

  return (
    <div className="lc-coach-drawing">
      <button
        type="button"
        className="lc-coach-drawing-toggle"
        aria-expanded={expanded}
        onClick={() => onToggle(!drawing.expanded || Boolean(drawing.redacted))}
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span className="lc-coach-drawing-label">
          {drawing.redacted && !drawing.expanded ? "[redacted] " : ""}
          Drawing
        </span>
        <span className="lc-muted lc-coach-drawing-title">{title}</span>
      </button>
      {expanded && (
        <div className="lc-coach-drawing-body">
          <Timeline
            program={drawing.program}
            initialFrame={drawing.frameIndex ?? 0}
            onFrame={onFrame}
          />
        </div>
      )}
    </div>
  );
}
