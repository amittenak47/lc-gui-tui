/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Ask / Draw / Review are composer flags that ride along with Send, not
 * standalone actions. Ask skips the staged pipeline; Review runs it.
 * Structured results (review, tests, nudges) render inside the message list
 * as assistant turns.
 */

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BridgeResponse, CoachProcessEvent, ReviewResponse } from "../api/types";
import { STAGE_LABELS } from "../api/types";
import { HoldButton } from "../components/HoldButton";
import { Tip } from "../components/Tip";
import { LONG_PRESS_MS } from "../util/gesture";
import { useIsMobile } from "../util/mobile";
import { PHOTO_ATTACH_LIMIT, pickPhotos } from "../util/photoAttach";
import type { MessageDrawing } from "../viz/drawingState";
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

/**
 * Controls that must stay tappable — do not start a message hold on these.
 * Process toggles are fine to hold through; thread open and reply stubs
 * navigate on tap and should not steal into the menu.
 */
function isLongPressBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "a, input, textarea, select, .lc-coach-thread-open, .lc-coach-reply-stub",
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

function replyRefFor(message: CoachChatMessage): CoachReplyRef {
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

const NOT_ON_SCRATCHPAD = "Not available on this pad";

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
 * has none of that: Draw has no region to draw into, Review has nothing staged
 * to review, Lazy has no `solution.py` to fill, and the analyse-on-send /
 * ambient cadence is a property of a problem attempt rather than of a page
 * being read. Rendering them disabled taught the writer nothing except that
 * five of the seven controls are dead, so on a pad they are not rendered.
 */
export type CoachSurface = "problem" | "pad";

/** What Annotate attaches — see {@link CoachSendFlags.annotateScope}. */
export type AnnotateScope = "board" | "view";

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
  /**
   * Attach board ink / annotated-code thumbnails to this send.
   * Independent of Review — Ask alone must not sneak annotations in.
   */
  annotate: boolean;
  /**
   * Images the writer attached with (+), as base64 PNGs.
   *
   * Not the same thing as `annotate`: those thumbnails are the board being
   * described back to the coach, these are evidence from outside it — a photo
   * of the page, a screenshot of an error, a diagram from somewhere else.
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
  /**
   * How much of the board {@link annotate} should attach.
   *
   * `board` is every page with the writer's marks on it, which is the right
   * answer when the question is about the shape of the work. `view` is the one
   * crop the writer could see when they asked, which is the right answer when
   * the question is about one figure on page forty — there, every other crop is
   * context the model has to rule out before it can answer.
   */
  annotateScope?: AnnotateScope;
  /** The message this turn is answering, when the writer quoted one. */
  replyTo?: CoachReplyRef;
  /** The thread this send belongs to, or null when it is addressed to the room. */
  threadRootId?: string | null;
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
  /** Raw base64 PNG (no data: prefix). */
  png: string;
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
  /** While {@link pending} — local ack before the daemon's first stage frame. */
  pendingAck?: CoachPendingAck;
  /** User message waiting in the FIFO send queue while the coach is busy. */
  queued?: boolean;
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
  /**
   * Problem attempt or reading pad — decides which composer controls exist at
   * all. Defaults to `problem` so nothing changes for the attempt flow.
   */
  coachSurface?: CoachSurface;
  /**
   * A quote pushed in from outside the panel — the document pad's "Coach" on a
   * text selection.
   *
   * Carries a token rather than being cleared by the panel, so quoting the same
   * sentence twice still lands: the effect keys off the token changing, and the
   * caller owns the value. The panel never writes back to it.
   */
  quoteSeed?: { token: number; text: string } | null;
  /**
   * Open this thread — a footnote tapped on the page. Same token contract as
   * {@link quoteSeed}; `null` id returns to the room.
   */
  focusThread?: { token: number; rootId: string | null } | null;
  onSend: (text: string, flags: CoachSendFlags, mode?: "queue" | "merge") => void;
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
  /** When true, the mobile sheet handle ignores drag (header toggle still works). */
  sheetDragLocked?: boolean;
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
  coachSurface = "problem",
  quoteSeed = null,
  focusThread = null,
  onSend,
  onThreadChange,
  forwardFailures = false,
  onForwardFailuresChange,
  onRequestBridge,
  onToggleDrawing,
  onDrawingFrame,
  children,
  sheetDragLocked = false,
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
  /**
   * Pads keep Ask and Annotate; the pipeline flags and the cadence toggles are
   * gone rather than greyed. See {@link CoachSurface}.
   */
  const padSurface = coachSurface === "pad";
  const [ask, setAsk] = useState(askOnly);
  const askActive = ask || askOnly;
  /** Annotate is greyed only where there is genuinely nothing to attach. */
  const annotateUnavailable = askOnly && !padSurface;
  const flagUnavailable = askOnly ? " lc-flag-unavailable" : "";
  const [draw, setDraw] = useState(false);
  const [reviewBoard, setReviewBoard] = useState(false);
  const [lazy, setLazy] = useState(false);
  const [annotate, setAnnotate] = useState(false);
  /**
   * Annotate's reach, chosen by holding it.
   *
   * Sticky across sends: a reader working through one chapter asks about this
   * figure, then the next one, and re-choosing "this view" every time would be
   * a tax on the mode they have already told us they are in.
   */
  const [annotateScope, setAnnotateScope] = useState<AnnotateScope>("board");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  /** Photos staged by (+), sent with the next message and cleared after. */
  const [photos, setPhotos] = useState<CoachAttachment[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const [lightbox, setLightbox] = useState<CoachAttachment | null>(null);
  const [lightboxClosing, setLightboxClosing] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
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

  const { threadReplies, rootMessages } = useMemo(() => groupThreads(messages), [messages]);

  const visibleMessages = useMemo(
    () => visibleThreadMessages(messages, openThreadId, { threadReplies, rootMessages }),
    [messages, openThreadId, threadReplies, rootMessages],
  );

  useEffect(() => {
    onThreadChange?.(openThreadId);
  }, [onThreadChange, openThreadId]);

  // A thread whose root has gone (cleared history, a trimmed session) must not
  // strand the panel in a view of nothing.
  useEffect(() => {
    if (openThreadId && !messages.some((message) => message.id === openThreadId)) {
      setOpenThreadId(null);
      setThreadMotion("idle");
      exitedRootRef.current = null;
      if (motionTimerRef.current != null) {
        window.clearTimeout(motionTimerRef.current);
        motionTimerRef.current = null;
      }
    }
  }, [messages, openThreadId]);

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
    window.setTimeout(() => composerRef.current?.focus(), 0);
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [sheetOffset, setSheetOffset] = useState<number | null>(null);
  /** Transitions armed only after the first measured park — avoids open→peek slide on mount. */
  const [sheetMotionOn, setSheetMotionOn] = useState(false);
  const sheetReadyRef = useRef(false);
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

  const sheetHeight = () => panelRef.current?.offsetHeight ?? 0;
  const closedOffset = () => Math.max(0, sheetHeight() - COACH_SHEET_PEEK_PX);

  /*
   * Publish how far the sheet is open, for chrome that has to answer to it.
   *
   * The board's toolbar sits where the sheet rises, so dragging the coach up
   * used to bury it — the controls were still there, still lit, under a panel.
   * Fading it out is the honest reading of "the coach has the screen now", and
   * it has to track the *drag*, not the end state, or the toolbar blinks off at
   * the start of a gesture the reader may not finish.
   *
   * A custom property rather than a prop: this changes every frame of a drag,
   * and threading it through App into Board would re-render the whole board
   * for something only the compositor needs. `--lc-coach-open` is 0..1, and
   * absent means desktop, where the coach is a side panel and covers nothing.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!mobile) {
      root.style.removeProperty("--lc-coach-open");
      root.classList.remove("lc-coach-dragging");
      return;
    }
    if (sheetOffset === null) {
      root.style.removeProperty("--lc-coach-open");
      root.classList.toggle("lc-coach-dragging", sheetDragging);
      return () => {
        root.style.removeProperty("--lc-coach-open");
        root.classList.remove("lc-coach-dragging");
      };
    }
    const closed = closedOffset();
    const parked = !open && closed > 0 && sheetOffset >= closed - 0.5;
    if (parked) {
      root.style.removeProperty("--lc-coach-open");
    } else {
      const shut = closed > 0 ? Math.min(1, Math.max(0, sheetOffset / closed)) : open ? 0 : 1;
      root.style.setProperty("--lc-coach-open", (1 - shut).toFixed(3));
    }
    root.classList.toggle("lc-coach-dragging", sheetDragging);
    return () => {
      root.style.removeProperty("--lc-coach-open");
      root.classList.remove("lc-coach-dragging");
    };
  }, [mobile, open, sheetOffset, sheetDragging]);

  useLayoutEffect(() => {
    if (!mobile || sheetDragging) return;
    const apply = () => {
      const height = sheetHeight();
      // Height 0 ⇒ closedOffset is 0 ⇒ translateY(0) paints the sheet fully open.
      // Stay hidden (sheetOffset null) until layout knows the real height.
      if (height <= 0) return;
      const next = open ? 0 : closedOffset();
      if (!open && next <= 0) return;
      setSheetOffset((prev) => {
        /*
         * First measured offset must snap. Arming transition before this paint
         * made the sheet animate from translateY(0) (full open) down to the
         * peek strip after the loading overlay lifted — "spawn mid-screen then
         * close". Keep motion off until that snap has committed.
         */
        if (prev === null) {
          setSheetMotionOn(false);
          sheetReadyRef.current = false;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              sheetReadyRef.current = true;
              setSheetMotionOn(true);
            });
          });
        }
        return next;
      });
    };
    apply();
    const id = window.requestAnimationFrame(apply);
    return () => {
      window.cancelAnimationFrame(id);
    };
  }, [mobile, open, sheetDragging]);

  useEffect(() => {
    if (!mobile) return;
    const onResize = () => {
      if (sheetDragRef.current) return;
      const height = sheetHeight();
      if (height <= 0) return;
      const next = open ? 0 : closedOffset();
      if (!open && next <= 0) return;
      setSheetOffset(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mobile, open]);

  // Ask-only workspaces pin Ask on and clear the flags they cannot honour.
  // Annotate is not one of them on a pad — see `annotateUnavailable`.
  useEffect(() => {
    if (!askOnly) return;
    setAsk(true);
    setDraw(false);
    setReviewBoard(false);
    setLazy(false);
    if (!padSurface) setAnnotate(false);
  }, [askOnly, padSurface]);

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
      if (!mobile || sheetDragLocked) return;
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
    [mobile, open, sheetDragLocked],
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
      if (sheetDragLocked) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setOpen(!open);
    },
    [open, setOpen, sheetDragLocked],
  );

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
    (event: PointerEvent<HTMLDivElement>) => {
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

  const openMessageMenu = useCallback(
    (messageId: string, anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      const chat = listRef.current?.getBoundingClientRect();
      const menuWidth = 168;
      const menuHeight = 44;
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
      setMessageMenu({ messageId, top, left, tall });
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
      node.scrollTop = node.scrollHeight;
      return;
    }
    const returning = exitedRootRef.current;
    if (!returning) return;
    exitedRootRef.current = null;
    requestAnimationFrame(() => jumpToMessage(returning));
  }, [openThreadId, jumpToMessage]);

  const quoteMessage = useCallback(
    (message: CoachChatMessage) => {
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
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    },
    [closeMessageMenu, onOpenChange, messages, armMotionFallback],
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

  const canSend =
    draft.trim().length > 0 ||
    ask ||
    draw ||
    reviewBoard ||
    lazy ||
    annotate ||
    photos.length > 0 ||
    // A quote on its own is a question: "what is this?".
    pageQuote != null;
  const menuMessage = messageMenu
    ? messages.find((message) => message.id === messageMenu.messageId)
    : undefined;
  const menuHasText = Boolean(menuMessage?.content.trim());

  const beginLongPress = (messageId: string, event: PointerEvent<HTMLDivElement>) => {
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
    }, 140);
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
    onSend(
      draft.trim(),
      {
        ask,
        draw,
        reviewBoard,
        lazy,
        annotate,
        ...(annotate ? { annotateScope } : {}),
        ...(photos.length > 0 ? { photos } : {}),
        ...(pageQuote ? { pageQuote: pageQuote.text } : {}),
        threadRootId: openThreadId,
        ...(replyTo ? { replyTo } : {}),
      },
      mode,
    );
    setReplyTo(null);
    setPageQuote(null);
    setDraft("");
    setAsk(askOnly);
    setDraw(false);
    setReviewBoard(false);
    setLazy(false);
    setAnnotate(false);
    setPhotos([]);
    setPhotoError(null);
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
          ...(sheetOffset !== null
            ? { transform: `translate3d(0, ${sheetOffset}px, 0)` }
            : { visibility: "hidden" as const }),
          transition:
            sheetDragging || !sheetMotionOn
              ? "none"
              : "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
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
      <div
        className={[
          "lc-coach-chat",
          openThreadId ? "is-threaded" : "",
          threadMotion === "idle" ? "" : `lc-thread-motion-${threadMotion}`,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {openThreadId && (
          <div className="lc-coach-thread-bar">
            <button
              type="button"
              className="lc-coach-thread-back"
              onClick={leaveThread}
            >
              ← Conversation
            </button>
            <span className="lc-coach-thread-title">
              Thread · {threadReplies.get(openThreadId)?.length ?? 0}{" "}
              {(threadReplies.get(openThreadId)?.length ?? 0) === 1 ? "reply" : "replies"}
            </span>
          </div>
        )}
        <div
          className="lc-coach-messages lc-scroll-pane"
          ref={listRef}
          key={openThreadId ?? "__room__"}
          aria-live="polite"
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            settleThreadMotion();
          }}
        >
          {messages.length === 0 && !children && !thinking && (
            <p className="lc-muted lc-coach-empty">
              {padSurface ? (
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
            const replyStub = message.replyTo;
            return (
            <div
              key={message.id}
              data-coach-message={message.id}
              className={`lc-coach-turn lc-coach-turn-selectable lc-coach-turn-${turnKind(message.role)}${
                messageMenu?.messageId === message.id
                  ? messageMenu.tall
                    ? " lc-coach-turn-selected lc-coach-turn-selected-tall"
                    : " lc-coach-turn-selected"
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
              {message.queued && (
                <span className="lc-coach-queued" aria-label="Queued message">Queued</span>
              )}
              {message.processEvents && message.processEvents.length > 0 && (
                <ProcessBlock events={message.processEvents} running={Boolean(message.pending)} />
              )}
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
                  className="lc-coach-reply-stub"
                  title={`Go to ${ROLE_LABEL[replyStub!.role]}'s message`}
                  onClick={(event) => {
                    event.stopPropagation();
                    jumpToMessage(replyStub!.id);
                  }}
                >
                  <span className="lc-coach-reply-stub-role">
                    {ROLE_LABEL[replyStub!.role]}
                  </span>
                  <span className="lc-coach-reply-stub-text">{replyStub!.excerpt}</span>
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
                    enterThread(message.id);
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
                  {pendingAckLine(message)}
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
            );
          })}
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

        <form className="lc-coach-composer" onSubmit={(event) => submit("queue", event)}>
          {pageQuote && (
            <div className="lc-coach-reply-chip lc-coach-quote-chip">
              <span className="lc-coach-reply-chip-mark" aria-hidden />
              <div className="lc-coach-reply-chip-text">
                <span className="lc-coach-reply-stub-role">Quoting the page</span>
                <span className="lc-coach-reply-stub-text">{pageQuote.excerpt}</span>
              </div>
              <button
                type="button"
                className="lc-coach-reply-chip-clear"
                aria-label="Drop the quote"
                title="Drop the quote"
                onClick={() => setPageQuote(null)}
              >
                ×
              </button>
            </div>
          )}
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
          {/*
            Staged photos sit above the textarea, not beside Send: they are part
            of the message being written, and an attachment you cannot see is an
            attachment you forget you made. Each is removable until it is sent.
          */}
          {photos.length > 0 && (
            <div className="lc-coach-photo-tray" aria-label="Attached photos">
              {photos.map((photo, index) => (
                <div className="lc-coach-photo-chip" key={`${photo.label}-${index}`}>
                  <img
                    src={`data:image/png;base64,${photo.thumb ?? photo.png}`}
                    alt={photo.label}
                  />
                  <button
                    type="button"
                    className="lc-coach-photo-chip-clear"
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
          <textarea
            ref={composerRef}
            value={draft}
            rows={6}
            placeholder="Ask the coach about your board or code…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.shiftKey) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) submit("merge");
              else submit("queue");
            }}
          />
          <div className="lc-coach-composer-bar">
            {/* Ambient stays greyed until AMBIENT_ENABLED is flipped. The
                socket + 120s loop are already wired in App / coachSocket. */}
            {!padSurface && (
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
            )}
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
              {!padSurface && (
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
              )}
              {/*
                Annotate survives on a pad where the pipeline flags do not: a
                reading pad has exactly the thing this attaches — a board with
                the writer's marks on the page. It is the natural partner to Ask
                there, so it stays live rather than inheriting askOnly's grey.
              */}
              <Tip
                tip={
                  annotateUnavailable
                    ? NOT_ON_SCRATCHPAD
                    : annotateScope === "view"
                      ? "Attach what you can see — hold to send the whole board instead"
                      : "Attach board ink / annotated code — hold to send this view only"
                }
                placement="left"
              >
                <span className="lc-coach-annotate-wrap">
                  <HoldButton
                    label={annotateScope === "view" ? "View" : "Annotation"}
                    className={`lc-flag lc-coach-annotate${
                      annotate ? " lc-flag-active" : ""
                    }${annotateUnavailable ? " lc-flag-unavailable" : ""}`}
                    pressed={annotate}
                    disabled={busy || annotateUnavailable}
                    // Tap is the toggle it always was; the hold is the new
                    // reach chooser, so neither gesture loses its old meaning.
                    onTap={() => setAnnotate((current) => !current)}
                    onConfirm={() => setScopeMenuOpen(true)}
                    resetKey={scopeMenuOpen}
                  />
                  {scopeMenuOpen && (
                    <>
                      <button
                        type="button"
                        className="lc-doc-sheet-backdrop"
                        aria-label="Dismiss annotate reach"
                        onClick={() => setScopeMenuOpen(false)}
                      />
                      <div className="lc-coach-scope-menu" role="menu">
                        {(
                          [
                            ["board", "Whole board", "Every page you have marked."],
                            ["view", "This view", "Just the crop you are looking at."],
                          ] as const
                        ).map(([id, title, hint]) => (
                          <button
                            key={id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={annotateScope === id}
                            className={
                              annotateScope === id
                                ? "lc-coach-scope-option is-active"
                                : "lc-coach-scope-option"
                            }
                            onClick={() => {
                              setAnnotateScope(id);
                              // Choosing a reach is choosing to attach: making
                              // the writer then tap the button they just held
                              // would be a second confirmation of one decision.
                              setAnnotate(true);
                              setScopeMenuOpen(false);
                            }}
                          >
                            <strong>{title}</strong>
                            <span className="lc-muted">{hint}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </span>
              </Tip>
              {!padSurface && (
                <>
                  <Tip
                    tip={
                      askOnly
                        ? NOT_ON_SCRATCHPAD
                        : ask
                          ? "Turn off Ask to use Review"
                          : photos.length > 0
                            ? REVIEW_DROPS_PHOTOS
                            : "Run a staged review of the board"
                    }
                    placement="left"
                  >
                    <button
                      type="button"
                      className={`lc-flag${reviewBoard ? " lc-flag-active" : ""}${flagUnavailable}`}
                      aria-pressed={reviewBoard}
                      disabled={busy || askOnly || ask || photos.length > 0}
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
                </>
              )}
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
                  className="lc-flag lc-coach-attach"
                  aria-label="Attach a photo"
                  disabled={
                    busy || picking || reviewBoard || photos.length >= PHOTO_ATTACH_LIMIT
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
                  +
                </button>
              </Tip>
              <button type="submit" disabled={!canSend}>
                Send
              </button>
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

/** Local ack while waiting for the daemon's `received` stage or the answer. */
export function pendingAckLine(message: CoachChatMessage): string {
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
