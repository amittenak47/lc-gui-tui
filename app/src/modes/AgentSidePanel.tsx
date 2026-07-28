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
import { BridgePanel } from "./RevealDialog";
import { ReviewPanel } from "./ReviewPanel";

export type CoachMode = "review" | "ambient";

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
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
  /** Structured review — rendered once as a card, not duplicated as prose. */
  review?: ReviewResponse;
  /** Hold-to-reveal bridge, nested under the review that offered it. */
  bridge?: BridgeResponse;
  /** Layout thumbnails when Review board was attached. */
  attachments?: CoachAttachment[];
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
  /** Structured cards (tests, timelines, …) rendered in the thread. */
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
              className={
                message.role === "user"
                  ? "lc-coach-turn lc-coach-turn-user"
                  : message.role === "system"
                    ? "lc-coach-turn lc-coach-turn-system"
                    : "lc-coach-turn lc-coach-turn-assistant"
              }
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
                {message.role === "user" ? "You" : message.role === "system" ? "System" : "Coach"}
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
                    bridgeOffered={Boolean(message.bridge)}
                  />
                </div>
              )}
              {message.bridge && (
                <BridgePanel bridge={message.bridge} compact collapsible defaultOpen />
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
              <Tip tip="Analyze every 60s" placement="right">
                <button
                  type="button"
                  className={mode === "ambient" ? "lc-mode lc-mode-active" : "lc-mode"}
                  aria-pressed={mode === "ambient"}
                  disabled={busy}
                  onClick={() => onModeChange("ambient")}
                >
                  Every 60s
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
