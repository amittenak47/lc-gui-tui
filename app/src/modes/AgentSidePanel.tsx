/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Draw / Review board are composer flags that ride along with Send, not
 * standalone actions. Structured results (review, tests, nudges) render
 * inside the message list as assistant turns.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";

import type { BridgeResponse, ReviewResponse } from "../api/types";
import { Tip } from "../components/Tip";
import type { MessageDrawing } from "../viz/drawingState";
import { Timeline } from "../viz/Timeline";
import { BridgePanel } from "./RevealDialog";
import { ReviewPanel } from "./ReviewPanel";

const LONG_PRESS_MS = 400;

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

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a, input, textarea, select, [role='button']"));
}

function formatMessageQuote(message: CoachChatMessage): string {
  const body = message.content.trim();
  if (!body) return "";
  const label = ROLE_LABEL[message.role];
  const quoted = body.split("\n").map((line) => `> ${line}`).join("\n");
  return `> **${label}:**\n${quoted}\n\n`;
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

interface MessageMenuState {
  messageId: string;
  top: number;
  left: number;
}

export interface CoachSendFlags {
  /** Ask the coach to draw on the board. */
  draw: boolean;
  /** Attach the current board (and code dock) to the request. */
  reviewBoard: boolean;
  /**
   * Fill the parts of solution.py the board already justifies (no reference
   * dump). Works with Draw / Review board / a plain question.
   */
  lazy: boolean;
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
  const [lazy, setLazy] = useState(false);
  const [lightbox, setLightbox] = useState<CoachAttachment | null>(null);
  const [lightboxClosing, setLightboxClosing] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    messageId: string | null;
    startX: number;
    startY: number;
    moved: boolean;
  }>({ timer: null, messageId: null, startX: 0, startY: 0, moved: false });

  const clearLongPress = useCallback(() => {
    const state = longPressRef.current;
    if (state.timer != null) clearTimeout(state.timer);
    state.timer = null;
    state.messageId = null;
    state.moved = false;
  }, []);

  const trackLongPressMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const state = longPressRef.current;
      if (state.timer == null || state.moved) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (dx * dx + dy * dy > 100) {
        state.moved = true;
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const openMessageMenu = useCallback(
    (messageId: string, anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      const menuWidth = 168;
      const pad = 8;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2, pad + menuWidth / 2),
        window.innerWidth - pad - menuWidth / 2,
      );
      const top = Math.max(rect.top - 6, pad + 44);
      setMessageMenu({ messageId, top, left });
      setCopyFlash(false);
    },
    [],
  );

  const closeMessageMenu = useCallback(() => {
    setMessageMenu(null);
    setCopyFlash(false);
    clearLongPress();
  }, [clearLongPress]);

  const quoteMessage = useCallback(
    (message: CoachChatMessage) => {
      const text = formatMessageQuote(message);
      if (!text) return;
      setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text));
      closeMessageMenu();
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    },
    [closeMessageMenu],
  );

  const copyMessage = useCallback(
    async (message: CoachChatMessage) => {
      const ok = await copyToClipboard(message.content);
      if (!ok) return;
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1200);
    },
    [],
  );

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

  useEffect(() => {
    if (!messageMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMessageMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messageMenu, closeMessageMenu]);

  if (!open) return null;

  const canSend = !busy && (draft.trim().length > 0 || draw || reviewBoard || lazy);
  const menuMessage = messageMenu
    ? messages.find((message) => message.id === messageMenu.messageId)
    : undefined;
  const menuHasText = Boolean(menuMessage?.content.trim());

  const beginLongPress = (messageId: string, event: PointerEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    clearLongPress();
    const node = event.currentTarget;
    longPressRef.current.messageId = messageId;
    longPressRef.current.startX = event.clientX;
    longPressRef.current.startY = event.clientY;
    longPressRef.current.moved = false;
    longPressRef.current.timer = window.setTimeout(() => {
      if (longPressRef.current.moved) return;
      openMessageMenu(messageId, node);
    }, LONG_PRESS_MS);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(draft.trim(), { draw, reviewBoard, lazy });
    setDraft("");
    closeMessageMenu();
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
              className={`lc-coach-turn lc-coach-turn-selectable lc-coach-turn-${turnKind(message.role)}${
                messageMenu?.messageId === message.id ? " lc-coach-turn-selected" : ""
              }`}
              onContextMenu={(event) => {
                if (isInteractiveTarget(event.target)) return;
                event.preventDefault();
                openMessageMenu(message.id, event.currentTarget);
              }}
              onPointerDown={(event) => beginLongPress(message.id, event)}
              onPointerMove={trackLongPressMove}
              onPointerUp={clearLongPress}
              onPointerCancel={clearLongPress}
              onPointerLeave={clearLongPress}
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
            ref={composerRef}
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
              <Tip
                tip="Drawing-first: interpret the board and fill the correct earned parts of solution.py"
                placement="left"
              >
                <button
                  type="button"
                  className={lazy ? "lc-flag lc-flag-active" : "lc-flag"}
                  aria-pressed={lazy}
                  disabled={busy}
                  onClick={() => setLazy((current) => !current)}
                >
                  Lazy
                </button>
              </Tip>
              <button type="submit" disabled={!canSend}>
                Send
              </button>
            </div>
          </div>
        </form>
      </div>

      {messageMenu && menuMessage && (
        <>
          <button
            type="button"
            className="lc-coach-message-menu-backdrop"
            aria-label="Dismiss message actions"
            onClick={closeMessageMenu}
          />
          <div
            className="lc-coach-message-menu"
            role="menu"
            style={{ top: messageMenu.top, left: messageMenu.left }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
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
          </div>
        </>
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
