/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Ask / Draw / Review are composer flags that ride along with Send, not
 * standalone actions. Ask skips the staged pipeline; Review runs it.
 * Structured results (review, tests, nudges) render inside the message list
 * as assistant turns.
 */

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { BridgeResponse, CoachProcessEvent, ReviewResponse } from "../api/types";
import { STAGE_LABELS } from "../api/types";
import { Tip } from "../components/Tip";
import { LONG_PRESS_MS } from "../util/gesture";
import { useIsMobile } from "../util/mobile";
import type { MessageDrawing } from "../viz/drawingState";
import { Timeline } from "../viz/Timeline";
import { BridgePanel } from "./RevealDialog";
import { ReviewPanel } from "./ReviewPanel";

/** Visible strip when the mobile coach sheet is parked closed. */
const COACH_SHEET_PEEK_PX = 52;
/** Drag past this fraction of sheet height (or fling) to snap open/closed. */
const COACH_SHEET_SNAP = 0.28;
const COACH_SHEET_FLING_VX = 0.55;

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

/** Longest stub shown in a reply bubble before it is cut. */
const REPLY_EXCERPT_MAX = 160;

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

/** The message a thread hangs off — walking up through any chain of replies. */
function messageThreadRoot(
  messages: readonly CoachChatMessage[],
  message: CoachChatMessage,
): string {
  let current: CoachChatMessage | undefined = message;
  const seen = new Set<string>();
  while (current?.replyTo && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId: string = current.replyTo.id;
    const parent = messages.find((candidate) => candidate.id === parentId);
    if (!parent) return parentId;
    current = parent;
  }
  return current?.id ?? message.id;
}

function replyRefFor(message: CoachChatMessage): CoachReplyRef | null {
  const excerpt = replyExcerpt(message.content);
  if (!excerpt) return null;
  return { id: message.id, role: message.role, excerpt };
}

/**
 * Scroll when the thread grows or a turn's content changes — not when the
 * student only scrubs a drawing's frameIndex (Prev / Play / Next).
 */
function coachScrollSignature(messages: CoachChatMessage[]): string {
  return messages
    .map((message) =>
      [
        message.id,
        message.role,
        message.content,
        message.pending ? "1" : "0",
        message.processEvents?.length ?? 0,
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

const NOT_ON_SCRATCHPAD = "Not available on scratchpad";

interface MessageMenuState {
  messageId: string;
  top: number;
  left: number;
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
  role: CoachChatMessage["role"];
  excerpt: string;
}

export interface CoachSendFlags {
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
  /** The message this turn is answering, when the writer quoted one. */
  replyTo?: CoachReplyRef;
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
  /** Composer flags that rode along with Send — footnotes under the bubble text. */
  flags?: string[];
  /**
   * What the coach did on the way to this answer, in order, as the daemon
   * reported it. Kept on the turn rather than in a global status line so it
   * survives scrollback: "which stage found the counterexample?" is a question
   * about a specific answer, asked after the fact.
   */
  processEvents?: CoachProcessEvent[];
  /** The request is still in flight — this turn is a placeholder. */
  pending?: boolean;
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
  open: boolean;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  /** Open / close the coach (header toggle + sheet snap). */
  onOpenChange?: (open: boolean) => void;
  /** @deprecated Prefer onOpenChange — kept for call sites that only close. */
  onClose?: () => void;
  busy: boolean;
  thinking?: boolean;
  /** Phased status while the local model works (replaces a bare "Thinking…"). */
  thinkingPhase?: string | null;
  messages: CoachChatMessage[];
  /**
   * Scratchpad: no solution.py, no review pipeline, no board regions to draw
   * into. Ask is pinned on and the other flags are disabled.
   */
  askOnly?: boolean;
  onSend: (text: string, flags: CoachSendFlags) => void;
  /** The open thread, so the caller can narrow what the coach is told. */
  onThreadChange?: (rootId: string | null) => void;
  /** Forward a failed test run to the coach without being asked. */
  forwardFailures?: boolean;
  onForwardFailuresChange?: (on: boolean) => void;
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
  onOpenChange,
  onClose,
  busy,
  thinking = false,
  thinkingPhase = null,
  messages,
  askOnly = false,
  onSend,
  onThreadChange,
  forwardFailures = false,
  onForwardFailuresChange,
  onRequestBridge,
  onToggleDrawing,
  onDrawingFrame,
  children,
}: AgentSidePanelProps) {
  const mobile = useIsMobile();
  const setOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next);
      if (!next) onClose?.();
    },
    [onClose, onOpenChange],
  );
  const [draft, setDraft] = useState("");
  const [ask, setAsk] = useState(askOnly);
  const askActive = ask || askOnly;
  const flagUnavailable = askOnly ? " lc-flag-unavailable" : "";
  const [draw, setDraw] = useState(false);
  const [reviewBoard, setReviewBoard] = useState(false);
  const [lazy, setLazy] = useState(false);
  const [lightbox, setLightbox] = useState<CoachAttachment | null>(null);
  const [lightboxClosing, setLightboxClosing] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  /** The turn the next send is answering, if the writer quoted one. */
  const [replyTo, setReplyTo] = useState<CoachReplyRef | null>(null);
  /**
   * The thread filling the panel, or null for the main conversation.
   *
   * A thread is identified by the message it hangs off rather than by an id of
   * its own: threads are not created, they are noticed — the second reply to a
   * message is what turns two turns into a conversation about it.
   */
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  /**
   * The conversation, grouped into roots and the threads hanging off them.
   *
   * A reply is threaded under the *root* of whatever it answers, not under the
   * message it directly quotes, so a back-and-forth stays one thread instead of
   * nesting a level deeper every turn. Nesting is what makes a quoted
   * conversation unreadable, and the writer only ever sees one thing: a
   * subconversation about a message.
   */
  const { threadReplies, rootMessages } = useMemo(() => {
    const rootOf = new Map<string, string>();
    const replies = new Map<string, CoachChatMessage[]>();
    const roots: CoachChatMessage[] = [];
    for (const message of messages) {
      const parent = message.replyTo?.id;
      if (!parent) {
        roots.push(message);
        continue;
      }
      // Follow the chain up: a reply to a reply belongs to the same thread.
      const root = rootOf.get(parent) ?? parent;
      rootOf.set(message.id, root);
      const bucket = replies.get(root);
      if (bucket) bucket.push(message);
      else replies.set(root, [message]);
    }
    return { threadReplies: replies, rootMessages: roots };
  }, [messages]);

  /**
   * What the transcript shows: the room, or one thread within it.
   *
   * A thread that is open takes the whole panel — its root at the top and its
   * replies under it — because a subconversation shown inline next to the
   * conversation it came from is the interleaving this exists to remove.
   */
  const visibleMessages = useMemo(() => {
    if (!openThreadId) return rootMessages;
    const root = messages.find((message) => message.id === openThreadId);
    const replies = threadReplies.get(openThreadId) ?? [];
    return root ? [root, ...replies] : replies;
  }, [messages, openThreadId, rootMessages, threadReplies]);

  useEffect(() => {
    onThreadChange?.(openThreadId);
  }, [onThreadChange, openThreadId]);

  // A thread whose root has gone (cleared history, a trimmed session) must not
  // strand the panel in a view of nothing.
  useEffect(() => {
    if (openThreadId && !messages.some((message) => message.id === openThreadId)) {
      setOpenThreadId(null);
    }
  }, [messages, openThreadId]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetDragRef = useRef<{
    pointerId: number;
    startY: number;
    startOffset: number;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    messageId: string | null;
    startX: number;
    startY: number;
    moved: boolean;
  }>({ timer: null, messageId: null, startX: 0, startY: 0, moved: false });

  const sheetHeight = () => panelRef.current?.offsetHeight ?? 0;
  const closedOffset = () => Math.max(0, sheetHeight() - COACH_SHEET_PEEK_PX);

  useLayoutEffect(() => {
    if (!mobile || sheetDragging) return;
    const apply = () => setSheetOffset(open ? 0 : closedOffset());
    apply();
    const id = window.requestAnimationFrame(apply);
    return () => window.cancelAnimationFrame(id);
  }, [mobile, open, sheetDragging]);

  useEffect(() => {
    if (!mobile) return;
    const onResize = () => {
      if (sheetDragRef.current) return;
      setSheetOffset(open ? 0 : closedOffset());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mobile, open]);

  // Ask-only workspaces pin Ask on and clear the flags they cannot honour.
  useEffect(() => {
    if (!askOnly) return;
    setAsk(true);
    setDraw(false);
    setReviewBoard(false);
    setLazy(false);
  }, [askOnly]);

  const endSheetDrag = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = sheetDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      sheetDragRef.current = null;
      setSheetDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }

      const closed = closedOffset();
      const offset = Math.min(
        closed,
        Math.max(0, drag.startOffset + (event.clientY - drag.startY)),
      );
      const travel = Math.abs(event.clientY - drag.startY);
      // Tap the handle to toggle when you didn't really drag.
      if (travel < 10) {
        const nextOpen = !open;
        setOpen(nextOpen);
        setSheetOffset(nextOpen ? 0 : closed);
        return;
      }
      const flungOpen = drag.velocity < -COACH_SHEET_FLING_VX;
      const flungClosed = drag.velocity > COACH_SHEET_FLING_VX;
      const nextOpen = flungOpen
        ? true
        : flungClosed
          ? false
          : offset < closed * (1 - COACH_SHEET_SNAP);
      setOpen(nextOpen);
      setSheetOffset(nextOpen ? 0 : closed);
    },
    [open, setOpen],
  );

  const onSheetHandlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!mobile) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const startOffset = open ? 0 : closedOffset();
      sheetDragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startOffset,
        lastY: event.clientY,
        lastT: performance.now(),
        velocity: 0,
      };
      setSheetDragging(true);
      setSheetOffset(startOffset);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [mobile, open],
  );

  const onSheetHandlePointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = sheetDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      const dy = event.clientY - drag.lastY;
      drag.velocity = dy / dt;
      drag.lastY = event.clientY;
      drag.lastT = now;
      const closed = closedOffset();
      const next = Math.min(
        closed,
        Math.max(0, drag.startOffset + (event.clientY - drag.startY)),
      );
      setSheetOffset(next);
    },
    [],
  );

  const onSheetHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setOpen(!open);
    },
    [open, setOpen],
  );

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

  /**
   * Scroll a quoted turn back into view and flash it.
   *
   * The flash matters: on a long thread the original may land anywhere in the
   * viewport after the scroll, and without something to catch the eye the jump
   * reads as the panel having moved for no reason.
   */
  const jumpToMessage = useCallback((id: string) => {
    const node = document.querySelector<HTMLElement>(`[data-coach-message="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("is-flashed");
    window.setTimeout(() => node.classList.remove("is-flashed"), 1400);
  }, []);

  const quoteMessage = useCallback(
    (message: CoachChatMessage) => {
      const ref = replyRefFor(message);
      if (!ref) return;
      // The draft is left alone. Quoting used to paste the whole answer in as
      // `>` prose, so replying to a long turn meant scrolling past a copy of it
      // to reach your own cursor — and the copy was all that survived, since a
      // sent message had no idea what it was answering.
      setReplyTo(ref);
      // Answering a message *is* its thread, so go there: the reply and the
      // ones before it belong in the same view, not scattered up the room.
      setOpenThreadId((current) => current ?? messageThreadRoot(messages, message));
      closeMessageMenu();
      onOpenChange?.(true);
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    },
    [closeMessageMenu, onOpenChange],
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

  if (!open && !mobile) return null;

  const canSend = !busy && (draft.trim().length > 0 || ask || draw || reviewBoard || lazy);
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
    onSend(draft.trim(), { ask, draw, reviewBoard, lazy, ...(replyTo ? { replyTo } : {}) });
    setReplyTo(null);
    setDraft("");
    setAsk(askOnly);
    setDraw(false);
    setReviewBoard(false);
    setLazy(false);
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

  const sheetStyle =
    mobile
      ? {
          transform: `translate3d(0, ${sheetOffset}px, 0)`,
          transition: sheetDragging ? "none" : "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        }
      : undefined;

  return (
    <aside
      ref={panelRef}
      className={[
        "lc-side",
        "lc-side-open",
        mobile ? "lc-side-sheet" : "",
        mobile && !open && !sheetDragging ? "lc-side-sheet-parked" : "",
        mobile && sheetDragging ? "lc-side-sheet-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      id="lc-coach-panel"
      aria-label="Coach"
      style={sheetStyle}
    >
      <div
        className="lc-coach-sheet-handle"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={open ? "Drag down to close coach" : "Drag up to open coach"}
        title={open ? "Drag down to close" : "Drag up to open"}
        onPointerDown={mobile ? onSheetHandlePointerDown : undefined}
        onPointerMove={mobile ? onSheetHandlePointerMove : undefined}
        onPointerUp={mobile ? endSheetDrag : undefined}
        onPointerCancel={mobile ? endSheetDrag : undefined}
        onKeyDown={onSheetHandleKeyDown}
        onClick={mobile ? undefined : () => setOpen(false)}
      >
        <span className="lc-coach-fold-bar" aria-hidden />
      </div>
      <div className={openThreadId ? "lc-coach-chat is-threaded" : "lc-coach-chat"}>
        {openThreadId && (
          <div className="lc-coach-thread-bar">
            <button
              type="button"
              className="lc-coach-thread-back"
              onClick={() => {
                setOpenThreadId(null);
                setReplyTo(null);
              }}
            >
              ← Conversation
            </button>
            <span className="lc-coach-thread-title">
              Thread · {threadReplies.get(openThreadId)?.length ?? 0}{" "}
              {(threadReplies.get(openThreadId)?.length ?? 0) === 1 ? "reply" : "replies"}
            </span>
          </div>
        )}
        <div className="lc-coach-messages" ref={listRef} aria-live="polite">
          {messages.length === 0 && !children && !thinking && (
            <p className="lc-muted lc-coach-empty">
              Ask a question with <strong>Ask</strong>, flag <strong>Review</strong> to run a
              staged board review, or <strong>Draw</strong> to request a diagram.
            </p>
          )}
          {visibleMessages.map((message) => (
            <div
              key={message.id}
              data-coach-message={message.id}
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
              {message.processEvents && message.processEvents.length > 0 && (
                <ProcessBlock events={message.processEvents} running={Boolean(message.pending)} />
              )}
              {message.replyTo && (
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
                  className="lc-coach-reply-stub"
                  title={`Go to ${ROLE_LABEL[message.replyTo.role]}'s message`}
                  onClick={(event) => {
                    event.stopPropagation();
                    jumpToMessage(message.replyTo!.id);
                  }}
                >
                  <span className="lc-coach-reply-stub-role">
                    {ROLE_LABEL[message.replyTo.role]}
                  </span>
                  <span className="lc-coach-reply-stub-text">{message.replyTo.excerpt}</span>
                </button>
              )}
              {message.content ? (
                <div className="lc-coach-turn-body">{message.content}</div>
              ) : null}
              {!openThreadId && (threadReplies.get(message.id)?.length ?? 0) > 0 && (
                /*
                 * The thread, collapsed to one line.
                 *
                 * Replies used to sit in the transcript as ordinary turns, so a
                 * message with three answers put three of them between you and
                 * whatever was said next, each carrying its own stub of the
                 * same quote. One bubble instead, and the back-and-forth lives
                 * behind it.
                 */
                <button
                  type="button"
                  className="lc-coach-thread-open"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenThreadId(message.id);
                  }}
                >
                  <span className="lc-coach-thread-open-count">
                    {threadReplies.get(message.id)!.length}{" "}
                    {threadReplies.get(message.id)!.length === 1 ? "reply" : "replies"}
                  </span>
                  <span className="lc-coach-thread-open-peek">
                    {threadReplies.get(message.id)!.at(-1)?.content.slice(0, 60)}
                  </span>
                  <span className="lc-coach-thread-open-chevron" aria-hidden>
                    ›
                  </span>
                </button>
              )}
              {message.flags && message.flags.length > 0 && (
                <div className="lc-coach-turn-footnotes">
                  <span className="lc-coach-turn-flag-rule" aria-hidden />
                  <div className="lc-coach-turn-flags" aria-label="Send flags">
                    {message.flags.map((flag) => (
                      <span key={flag} className="lc-coach-turn-flag">
                        {flag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {message.pending && !message.processEvents?.length && (
                <div className="lc-coach-turn-body">
                  <span className="lc-coach-spinner" aria-hidden />
                  Working…
                </div>
              )}
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
          {thinking && !messages.some((message) => message.pending) && (
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
          {replyTo && (
            <div className="lc-coach-reply-chip">
              <span className="lc-coach-reply-chip-mark" aria-hidden />
              <div className="lc-coach-reply-chip-text">
                <span className="lc-coach-reply-stub-role">
                  Replying to {ROLE_LABEL[replyTo.role]}
                </span>
                <span className="lc-coach-reply-stub-text">{replyTo.excerpt}</span>
              </div>
              <button
                type="button"
                className="lc-coach-reply-chip-clear"
                aria-label="Cancel reply"
                title="Cancel reply"
                onClick={() => setReplyTo(null)}
              >
                ×
              </button>
            </div>
          )}
          <textarea
            ref={composerRef}
            value={draft}
            rows={6}
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
              {onForwardFailuresChange && (
                <Tip tip="Send failed test runs to the coach automatically" placement="right">
                  <button
                    type="button"
                    className={forwardFailures ? "lc-mode lc-mode-active" : "lc-mode"}
                    aria-pressed={forwardFailures}
                    disabled={busy}
                    onClick={() => onForwardFailuresChange(!forwardFailures)}
                  >
                    Failures
                  </button>
                </Tip>
              )}
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
              <Tip
                tip={
                  askOnly
                    ? "Scratchpad answers questions only"
                    : lazy || reviewBoard
                      ? "Turn off Review / Lazy to use Ask"
                      : "Ask a question without the staged review pipeline"
                }
                placement="left"
              >
                <button
                  type="button"
                  className={askActive ? "lc-flag lc-flag-active" : "lc-flag"}
                  aria-pressed={askActive}
                  disabled={busy || (!askOnly && (lazy || reviewBoard))}
                  onClick={() => {
                    if (askOnly) return;
                    setAsk((current) => {
                      const next = !current;
                      if (next) {
                        setLazy(false);
                        setReviewBoard(false);
                      }
                      return next;
                    });
                  }}
                >
                  Ask
                </button>
              </Tip>
              <Tip
                tip={
                  askOnly ? NOT_ON_SCRATCHPAD : "Allow coach to draw on the board"
                }
                placement="left"
              >
                <button
                  type="button"
                  className={`lc-flag${draw ? " lc-flag-active" : ""}${flagUnavailable}`}
                  aria-pressed={draw}
                  disabled={busy || askOnly}
                  onClick={() => setDraw((current) => !current)}
                >
                  Draw
                </button>
              </Tip>
              <Tip
                tip={
                  askOnly
                    ? NOT_ON_SCRATCHPAD
                    : ask
                      ? "Turn off Ask to use Review"
                      : "Run a staged review of the board"
                }
                placement="left"
              >
                <button
                  type="button"
                  className={`lc-flag${reviewBoard ? " lc-flag-active" : ""}${flagUnavailable}`}
                  aria-pressed={reviewBoard}
                  disabled={busy || askOnly || ask}
                  onClick={() =>
                    setReviewBoard((current) => {
                      const next = !current;
                      if (next) setAsk(false);
                      return next;
                    })
                  }
                >
                  Review
                </button>
              </Tip>
              <Tip
                tip={
                  askOnly
                    ? NOT_ON_SCRATCHPAD
                    : ask
                      ? "Turn off Ask to use Lazy"
                      : "Drawing-first: interpret the board and fill the correct earned parts of solution.py"
                }
                placement="left"
              >
                <button
                  type="button"
                  className={`lc-flag${lazy ? " lc-flag-active" : ""}${flagUnavailable}`}
                  aria-pressed={lazy}
                  disabled={busy || askOnly || ask}
                  onClick={() =>
                    setLazy((current) => {
                      const next = !current;
                      if (next) setAsk(false);
                      return next;
                    })
                  }
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
              Quote in reply
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

/**
 * What the coach did, one line per stage or tool call.
 *
 * Collapsed once the answer lands: the answer is what the student came for,
 * and a finished process log they did not ask to see is noise. While the run
 * is working it stays open, because then it *is* the content.
 */
function ProcessBlock({
  events,
  running,
}: {
  events: CoachProcessEvent[];
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = running || open;
  // "done" closes the block rather than adding a line to it.
  const shown = events.filter((event) => event.label !== "done");
  const latest = shown[shown.length - 1];
  if (shown.length === 0) return null;

  return (
    <div className={running ? "lc-coach-process lc-coach-process-running" : "lc-coach-process"}>
      <button
        type="button"
        className="lc-coach-process-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        {running && <span className="lc-coach-spinner" aria-hidden />}
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span className="lc-coach-process-label">
          {running ? processLine(latest) : `${shown.length} step${shown.length === 1 ? "" : "s"}`}
        </span>
      </button>
      {expanded && (
        <ol className="lc-coach-process-steps">
          {shown.map((event, index) => (
            <li
              key={`${event.ts}-${index}`}
              className={
                event.status === "rejected"
                  ? "lc-coach-process-step lc-coach-process-step-rejected"
                  : "lc-coach-process-step"
              }
            >
              {processLine(event)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One process line. Unknown stage names fall back to the daemon's own text. */
function processLine(event: CoachProcessEvent | undefined): string {
  if (!event) return "Working…";
  if (event.kind === "tool") {
    const verb =
      event.status === "rejected"
        ? "dropped"
        : event.status === "accepted"
          ? "drew"
          : "asked for";
    return [`${verb} ${event.label}`, event.detail].filter(Boolean).join(" — ");
  }
  return STAGE_LABELS[event.label] ?? event.detail ?? event.label;
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
