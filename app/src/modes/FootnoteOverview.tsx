import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { AgentChatMessage } from "./AgentSidePanel";
import {
  freshNoteId,
  type DocFootnote,
  type DocFootnoteNote,
  type DocFootnoteSubMarkKind,
  type DocFootnoteUserLink,
} from "../util/docFootnotes";
import { ColorRadial } from "../canvas/ColorRadial";
import { HoldButton } from "../components/HoldButton";
import { UnderlineIcon } from "../components/MarkToolIcons";
import { pointerInSubMark } from "../canvas/docSelectionGesture";
import { copyTextToClipboard } from "../util/clipboard";
import { loadInkHandedness } from "../util/inkHandedness";
import {
  normalizePalette,
  paletteForMarkIndex,
  remapColorToPalette,
  stepFallbackPalette,
} from "../util/inkPaletteHistory";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { fitTextareaHeight } from "../util/fitTextareaHeight";
import { normalizeExternalUrl } from "../util/openExternal";
import { HOLD_SENSITIVE_MS } from "../util/gesture";
export interface FootnoteOverviewProps {
  footnote: DocFootnote;
  number?: number;
  /** The turns of one saved thread — the card asks per thread, as it opens them. */
  threadMessages: (rootId: string) => AgentChatMessage[];
  onClose: () => void;
  onChange: (next: DocFootnote) => void;
  /** `null` starts a new thread; a rootId continues that one. */
  onSendCoach: (text: string, threadRootId: string | null) => void;
  /** Queue this mark onto the main coach composer. */
  onAttachCoach?: (footnoteId: string) => void;
  onOpenExternal: (url: string) => void;
  anchorRect?: DOMRect | null;
  subMarkMode: DocFootnoteSubMarkKind | null;
  onSubMarkModeChange: (mode: DocFootnoteSubMarkKind | null) => void;
  /** Open directly into a saved coach thread from the mark hub. */
  openThreadRootId?: string | null;
  /** Hub-row hover — page paints that sub-mark's span. */
  onHoverSubMark?: (id: string | null) => void;
  /**
   * Underline tool on: the hub wheel paints this theme, not the panel's.
   * Null until the first seed after arming.
   */
  subMarkPaintTheme?: { color: string; palette: string[] } | null;
  onSubMarkPaintTheme?: (theme: { color: string; palette: string[] }) => void;
  /** Committed underline the wheel currently retints. Null = live / next line. */
  activeSubMarkId?: string | null;
  onActiveSubMarkIdChange?: (id: string | null) => void;
  /**
   * Links to other workspaces, as opposed to the external URLs above.
   *
   * Kept as a separate list on purpose: "link to my DP notebook" is not a
   * `https://`, and stuffing it into one would mean either a fake URL scheme
   * or a list where half the rows do not open in a browser.
   */
  workspaceLinks?: ReadonlyArray<{ edgeId: string; title: string; kindLabel: string }>;
  onAddWorkspaceLink?: () => void;
  onOpenWorkspaceLink?: (edgeId: string) => void;
  onRemoveWorkspaceLink?: (edgeId: string) => void;
}
type Task =
  | { kind: "note"; id: string | null }
  | { kind: "thread"; rootId: string | null }
  | { kind: "link"; index: number | null };
function turnKind(role: AgentChatMessage["role"]): "user" | "assistant" | "system" | "app" {
  if (role === "user" || role === "system" || role === "app") return role;
  return "assistant";
}
function viewport() {
  const view = window.visualViewport;
  return {
    width: view?.width ?? window.innerWidth,
    height: view?.height ?? window.innerHeight,
    originX: view?.offsetLeft ?? 0,
    originY: view?.offsetTop ?? 0,
  };
}
/** Board pane that contains the mark — split view must not clamp to the window. */
function paneBox(anchorRect: DOMRect | null | undefined): DOMRect {
  if (anchorRect) {
    const cx = anchorRect.left + anchorRect.width / 2;
    const cy = anchorRect.top + anchorRect.height / 2;
    for (const board of document.querySelectorAll(".lc-board")) {
      const box = board.getBoundingClientRect();
      if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
        return box;
      }
    }
  }
  const view = viewport();
  return new DOMRect(view.originX, view.originY, view.width, view.height);
}
function settle(node: HTMLElement, left: number, top: number, bounds: DOMRect) {
  const margin = 8;
  const maxLeft = Math.max(bounds.left + margin, bounds.right - node.offsetWidth - margin);
  const maxTop = Math.max(bounds.top + margin, bounds.bottom - node.offsetHeight - margin);
  node.style.left = `${Math.round(Math.min(Math.max(bounds.left + margin, left), maxLeft))}px`;
  node.style.top = `${Math.round(Math.min(Math.max(bounds.top + margin, top), maxTop))}px`;
  node.style.visibility = "visible";
}
function clampPanel(node: HTMLElement, anchorRect: DOMRect | null | undefined) {
  const margin = 8;
  const pane = paneBox(anchorRect);
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left: number;
  let top: number;
  if (anchorRect) {
    left = anchorRect.left + anchorRect.width / 2 - width / 2;
    const below = anchorRect.bottom + 6;
    top =
      below + height + margin > pane.bottom
        ? anchorRect.top - height - 6
        : below;
  } else {
    left = pane.left + pane.width / 2 - width / 2;
    top = pane.top + pane.height / 2 - height / 2;
  }
  settle(node, left, top, pane);
}
function applyViewportSize(node: HTMLElement, task: Task | null, compact = false) {
  const margin = 16;
  const { width, height } = viewport();
  node.style.setProperty("--lc-vvh", `${Math.round(height)}px`);
  node.style.setProperty("--lc-vvw", `${Math.round(width)}px`);
  const maxH = Math.round(height - margin * 2);
  const maxW = Math.min(280, Math.round(width - margin * 2));
  node.style.maxWidth = `${maxW}px`;
  node.style.height = "";
  if (task?.kind === "thread") {
    node.style.maxHeight = `${Math.min(Math.round(height * 0.62), maxH, 520)}px`;
  } else if (task) {
    node.style.maxHeight = `${Math.min(320, maxH)}px`;
  } else if (compact) {
    node.style.maxHeight = `${Math.min(132, maxH)}px`;
  } else {
    node.style.maxHeight = `${Math.min(Math.round(height * 0.7), maxH, 420)}px`;
  }
}

/** Hub heading: looks like a title until double-click opens a field. */
function MarkTitle({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (next: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const labeled = value?.replace(/\s+/g, " ").trim() ?? "";

  useLayoutEffect(() => {
    if (!editing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, [editing]);

  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    onCommit(next.length > 0 ? next : undefined);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="lc-footnote-overview-title is-editing"
        value={draft}
        placeholder="Title"
        aria-label="Mark title"
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`lc-footnote-overview-title-display${labeled ? "" : " is-empty"}`}
      aria-label={labeled ? "Mark title, double-click to edit" : "Add title, double-click to edit"}
      title="Double-click to edit title"
      onDoubleClick={(event) => {
        event.preventDefault();
        setDraft(value ?? "");
        setEditing(true);
      }}
    >
      {labeled || "Title"}
    </button>
  );
}
/**
 * Footnote overview — doc-sheet chrome, user links only, mini coach thread.
 * Does not open the docked coach panel.
 */
export function FootnoteOverview({
  footnote,
  number: footnoteNumber,
  threadMessages,
  onClose,
  onChange,
  onSendCoach,
  onAttachCoach,
  onOpenExternal,
  workspaceLinks = [],
  onAddWorkspaceLink,
  onOpenWorkspaceLink,
  onRemoveWorkspaceLink,
  anchorRect,
  subMarkMode,
  onSubMarkModeChange,
  openThreadRootId = null,
  onHoverSubMark,
  subMarkPaintTheme = null,
  onSubMarkPaintTheme,
  activeSubMarkId = null,
  onActiveSubMarkIdChange,
}: FootnoteOverviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [draft, setDraft] = useState("");
  const palette =
    normalizePalette(footnote.palette) ?? paletteForMarkIndex((footnoteNumber ?? 1) - 1);
  const handedness = loadInkHandedness();
  const markColor = footnote.color ?? palette[0] ?? "#0d9488";
  const userLinks = footnote.userLinks ?? [];
  const notes = footnote.notes ?? [];
  const threads = footnote.threads ?? [];
  const subMarks = footnote.subMarks ?? [];
  const isAiTab = footnote.kind === "ai";
  const searchLink =
    footnote.kind === "search" && footnote.url
      ? { title: footnote.query || "Search", url: footnote.url }
      : null;
  const [copied, setCopied] = useState(false);
  const footnoteRef = useRef(footnote);
  footnoteRef.current = footnote;

  const persistMarkPalette = (nextPalette: string[], nextColor: string) => {
    const current = footnoteRef.current;
    onChange({ ...current, palette: nextPalette, color: nextColor });
  };
  const underlineArmed = subMarkMode === "underline";
  const wheelPalette = underlineArmed
    ? (subMarkPaintTheme?.palette ?? stepFallbackPalette(palette, 1))
    : palette;
  const wheelColor = underlineArmed
    ? (subMarkPaintTheme?.color ?? wheelPalette[0] ?? "#0d9488")
    : markColor;
  const persistWheel = (nextPalette: string[], nextColor: string) => {
    if (underlineArmed) {
      onSubMarkPaintTheme?.({ palette: nextPalette, color: nextColor });
      if (activeSubMarkId) {
        const current = footnoteRef.current;
        onChange({
          ...current,
          subMarks: (current.subMarks ?? []).map((mark) =>
            mark.id === activeSubMarkId
              ? { ...mark, palette: nextPalette, color: nextColor }
              : mark,
          ),
        });
      }
      return;
    }
    persistMarkPalette(nextPalette, nextColor);
  };
  const cycleMarkPalette = (delta: 1 | -1) => {
    const next = stepFallbackPalette(wheelPalette, delta);
    persistWheel(next, remapColorToPalette(wheelColor, wheelPalette, next));
  };

  const prevSubMarkModeRef = useRef<DocFootnoteSubMarkKind | null>(null);
  useEffect(() => {
    const prev = prevSubMarkModeRef.current;
    prevSubMarkModeRef.current = subMarkMode;
    if (subMarkMode !== "underline" || prev === "underline") return;
    const next = stepFallbackPalette(palette, 1);
    onSubMarkPaintTheme?.({ palette: next, color: next[0] ?? "#0d9488" });
    onActiveSubMarkIdChange?.(null);
  }, [subMarkMode, palette, onSubMarkPaintTheme, onActiveSubMarkIdChange]);

  useLayoutEffect(() => {
    if (task?.kind !== "thread") return;
    const node = replyRef.current;
    if (!node) return;
    fitTextareaHeight(node);
  }, [draft, task]);

  useEffect(() => {
    if (!openThreadRootId) return;
    setTask({ kind: "thread", rootId: openThreadRootId });
  }, [openThreadRootId]);

  useEffect(() => () => onHoverSubMark?.(null), [onHoverSubMark]);

  const hasPanelContent =
    userLinks.length > 0 ||
    notes.length > 0 ||
    threads.length > 0 ||
    subMarks.length > 0;

  const clearPanelContent = () => {
    const current = footnoteRef.current;
    onChange({
      ...current,
      userLinks: undefined,
      notes: undefined,
      threads: undefined,
      subMarks: undefined,
      ...(current.threadRootId ? { threadRootId: undefined } : {}),
    });
    setTask(null);
    setDraft("");
    if (subMarkMode) onSubMarkModeChange(null);
  };

  // Let the page receive pointers so the reader can select inside the mark.
  // Close when the down is outside the panel and outside the mark bands.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const el = event.target instanceof Element ? event.target : null;
      if (
        el?.closest?.(
          ".lc-footnote-overview, .lc-doc-sheet, .lc-doc-confirm, .lc-doc-selection-chrome, .lc-doc-submark-grip, .lc-split-sash",
        )
      ) {
        return;
      }
      if (pointerInSubMark(event.clientX, event.clientY)) return;
      if (task) {
        setTask(null);
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose, task]);

  // Highlight sub-mark retired from the panel — clear a leftover armed mode.
  useEffect(() => {
    if (subMarkMode === "highlight") onSubMarkModeChange(null);
  }, [subMarkMode, onSubMarkModeChange]);

  const copyMarkText = useCallback(async () => {
    const live = window.getSelection()?.toString().trim() ?? "";
    const text =
      live ||
      footnote.blockText?.trim() ||
      footnote.excerpt?.trim() ||
      "";
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }, [footnote.blockText, footnote.excerpt]);

  const place = useCallback(() => {
    const node = panelRef.current;
    if (!node) return;
    applyViewportSize(node, task);
    clampPanel(node, anchorRect);
  }, [anchorRect, task]);
  useLayoutEffect(() => {
    place();
    const node = panelRef.current;
    const view = window.visualViewport;
    view?.addEventListener("resize", place);
    view?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    const observer =
      node && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => place())
        : null;
    if (node && observer) observer.observe(node);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", place);
      view?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [place, task, notes.length, threads.length, userLinks.length, subMarks.length]);
  const openThreadMessages = useMemo(
    () => (task?.kind === "thread" && task.rootId ? threadMessages(task.rootId) : []),
    [task, threadMessages],
  );
  useLayoutEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [openThreadMessages]);
  const updateNotes = (next: DocFootnoteNote[]) => {
    onChange({ ...footnote, notes: next.length > 0 ? next : undefined });
  };
  const saveNote = (text: string) => {
    if (task?.kind !== "note") return;
    const body = text.trim();
    const now = Date.now();
    if (!body) {
      if (task.id) updateNotes(notes.filter((note) => note.id !== task.id));
      setTask(null);
      return;
    }
    if (task.id) {
      updateNotes(
        notes.map((note) => (note.id === task.id ? { ...note, text: body, updatedAt: now } : note)),
      );
    } else {
      updateNotes([...notes, { id: freshNoteId(notes, now), text: body, createdAt: now, updatedAt: now }]);
    }
    setTask(null);
  };
  const updateUserLinks = (next: DocFootnoteUserLink[]) => {
    onChange({ ...footnote, userLinks: next.length > 0 ? next : undefined });
  };
  const saveLink = (url: string, title?: string) => {
    if (task?.kind !== "link") return;
    const trimmed = normalizeExternalUrl(url);
    if (!trimmed) return;
    const entry: DocFootnoteUserLink = title?.trim()
      ? { url: trimmed, title: title.trim() }
      : { url: trimmed };
    if (task.index != null) {
      updateUserLinks(userLinks.map((link, i) => (i === task.index ? entry : link)));
    } else {
      updateUserLinks([...userLinks, entry]);
    }
    setTask(null);
  };
  const removeUserLink = (index: number) => {
    updateUserLinks(userLinks.filter((_, i) => i !== index));
    if (task?.kind === "link" && task.index === index) setTask(null);
  };
  const removeThread = (rootId: string) => {
    const next = threads.filter((thread) => thread.rootId !== rootId);
    onChange({
      ...footnote,
      threads: next.length > 0 ? next : undefined,
      ...(footnote.threadRootId === rootId ? { threadRootId: next[0]?.rootId } : {}),
    });
    if (task?.kind === "thread" && task.rootId === rootId) setTask(null);
  };
  const send = () => {
    if (task?.kind !== "thread" || !task.rootId) return;
    const text = draft.trim();
    if (!text) return;
    onSendCoach(text, task.rootId);
    setDraft("");
  };
  const openTask = (next: Task) => {
    setDraft("");
    if (subMarkMode) onSubMarkModeChange(null);
    setTask(next);
  };
  const removeSubMark = (id: string) => {
    onHoverSubMark?.(null);
    if (activeSubMarkId === id) onActiveSubMarkIdChange?.(null);
    const next = subMarks.filter((mark) => mark.id !== id);
    onChange({ ...footnote, subMarks: next.length > 0 ? next : undefined });
  };
  const selectSubMark = (mark: (typeof subMarks)[number]) => {
    if (subMarkMode !== "underline") return;
    const nextPalette =
      normalizePalette(mark.palette) ?? subMarkPaintTheme?.palette ?? stepFallbackPalette(palette, 1);
    const nextColor = mark.color ?? nextPalette[0] ?? "#0d9488";
    onActiveSubMarkIdChange?.(mark.id);
    onSubMarkPaintTheme?.({ palette: nextPalette, color: nextColor });
  };
  const editingNote =
    task?.kind === "note" ? notes.find((note) => note.id === task.id) ?? null : null;
  const editingLink =
    task?.kind === "link" && task.index != null ? userLinks[task.index] ?? null : null;
  const tint = footnoteThemeVars(markColor, palette);
  const taskMotion = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const },
  };
  const taskClass =
    task?.kind === "thread"
      ? " is-task is-task-thread"
      : task
        ? " is-task is-task-compact"
        : "";
  return createPortal(
    <>
      <button
        type="button"
        className="lc-doc-sheet-backdrop is-pass-through"
        aria-label={task ? "Back to footnote" : "Close footnote"}
        tabIndex={-1}
        style={{ zIndex: 232 }}
      />
      <motion.div
        className={`lc-doc-sheet lc-footnote-overview${taskClass}`}
        ref={panelRef}
        role="dialog"
        aria-label={
          task?.kind === "note"
            ? "Note"
            : task?.kind === "link"
              ? "Link"
            : task?.kind === "thread"
              ? "Thread"
              : footnoteNumber != null
                ? `Footnote ${footnoteNumber}`
                : "Footnote"
        }
        style={{ visibility: "hidden", zIndex: 233, ...tint }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {task?.kind === "note" ? (
            <motion.div
              key="task-note"
              className="lc-footnote-overview-task lc-footnote-overview-task-compact"
              {...taskMotion}
            >
              <NoteTask
                key={editingNote?.id ?? "new"}
                initial={editingNote?.text ?? ""}
                onSave={saveNote}
                onBack={() => setTask(null)}
              />
            </motion.div>
          ) : task?.kind === "link" ? (
            <motion.div
              key="task-link"
              className="lc-footnote-overview-task lc-footnote-overview-task-compact"
              {...taskMotion}
            >
              <LinkTask
                key={editingLink?.url ?? "new"}
                initialUrl={editingLink?.url ?? ""}
                initialTitle={editingLink?.title ?? ""}
                onSave={saveLink}
                onRemove={
                  task.index != null
                    ? () => {
                        removeUserLink(task.index!);
                      }
                    : undefined
                }
                onBack={() => setTask(null)}
              />
            </motion.div>
          ) : task?.kind === "thread" ? (
            <motion.div
              key={`task-thread-${task.rootId ?? "new"}`}
              className="lc-footnote-overview-task lc-footnote-overview-task-thread"
              {...taskMotion}
            >
              <div className="lc-footnote-task-head">
                <button type="button" className="lc-secondary" onClick={() => setTask(null)}>
                  Back
                </button>
                <span className="lc-footnote-task-title">
                  {task.rootId
                    ? threads.find((thread) => thread.rootId === task.rootId)?.title ?? "Thread"
                    : "Thread"}
                </span>
                {task.rootId && (
                  <button
                    type="button"
                    className="lc-secondary"
                    aria-label="Forget thread"
                    onClick={() => removeThread(task.rootId!)}
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="lc-agent-messages lc-footnote-overview-thread" ref={transcriptRef}>
                {openThreadMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`lc-agent-turn lc-agent-turn-${turnKind(message.role)}`}
                  >
                    <div className="lc-agent-turn-role">
                      {turnKind(message.role) === "user" ? "You" : "Agent"}
                    </div>
                    <div className="lc-agent-turn-body">
                      {message.content || (message.pending ? "…" : "")}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="lc-agent-composer lc-footnote-overview-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <textarea
                  ref={replyRef}
                  value={draft}
                  rows={3}
                  placeholder="Reply…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    if (event.shiftKey) return;
                    event.preventDefault();
                    send();
                  }}
                  aria-label="Reply"
                />
                <div className="lc-agent-composer-bar">
                  <div className="lc-agent-composer-actions">
                    <button type="submit" disabled={draft.trim().length === 0} aria-label="Send">
                      <span className="lc-label-long">Send</span>
                      <span className="lc-label-short" aria-hidden>
                        S
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          ) : (
            <motion.div
              key="hub"
              className="lc-footnote-overview-hub"
              {...taskMotion}
            >
              <MarkTitle
                value={footnote.title}
                onCommit={(title) => onChange({ ...footnoteRef.current, title })}
              />
              <header className="lc-footnote-overview-toolbar" aria-label="Mark style">
                <div className="lc-footnote-submark-modes" role="group" aria-label="Mark actions">
                  <button
                    type="button"
                    className={`lc-footnote-mark-tool${subMarkMode === "underline" ? " is-active" : ""}`}
                    aria-label="Underline"
                    title="Underline"
                    aria-pressed={subMarkMode === "underline"}
                    onClick={() =>
                      onSubMarkModeChange(subMarkMode === "underline" ? null : "underline")
                    }
                  >
                    <UnderlineIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className={`lc-footnote-mark-tool lc-footnote-copy-tool${copied ? " is-copied" : ""}`}
                    aria-label={copied ? "Copied" : "Copy"}
                    title={copied ? "Copied" : "Select text in the mark, then copy — or copy the whole mark"}
                    onClick={() => {
                      void copyMarkText();
                    }}
                  >
                    <span aria-hidden>{copied ? "✓" : "📋"}</span>
                  </button>
                  {onAttachCoach && (
                    <button
                      type="button"
                      className="lc-footnote-mark-tool"
                      aria-label="Attach to chat"
                      title="Attach to chat"
                      onClick={() => onAttachCoach(footnote.id)}
                    >
                      <span aria-hidden>💬</span>
                    </button>
                  )}
                </div>
                <div className="lc-footnote-overview-color">
                  <ColorRadial
                    colors={wheelPalette}
                    value={wheelColor}
                    onPick={(color) => persistWheel(wheelPalette, color)}
                    onCycleNext={() => cycleMarkPalette(1)}
                    onCyclePrev={() => cycleMarkPalette(-1)}
                    onEditColor={(index, color) => {
                      const next = wheelPalette.map((swatch, i) => (i === index ? color : swatch));
                      const selected =
                        wheelPalette[index]?.trim().toLowerCase() ===
                        wheelColor.trim().toLowerCase();
                      persistWheel(next, selected ? color : wheelColor);
                    }}
                    handedness={handedness}
                    compact
                    wheelZIndex={240}
                  />
                </div>
                {hasPanelContent && (
                  <button
                    type="button"
                    className="lc-footnote-panel-clear"
                    aria-label="Clear links, notes, threads, and sub-marks"
                    title="Clear panel content"
                    onClick={clearPanelContent}
                  >
                    ✕
                  </button>
                )}
              </header>
              {subMarks.length > 0 && (
                <ul
                  className={listClass(subMarks.length)}
                  aria-label="Sub-marks"
                >
                  {subMarks.map((mark) => (
                    <li
                      key={mark.id}
                      className={`lc-footnote-overview-link-row${
                        activeSubMarkId === mark.id ? " is-selected" : ""
                      }`}
                      style={
                        mark.color
                          ? footnoteThemeVars(
                              mark.color,
                              normalizePalette(mark.palette) ?? palette,
                            )
                          : undefined
                      }
                      onPointerEnter={() => onHoverSubMark?.(mark.id)}
                      onPointerLeave={() => onHoverSubMark?.(null)}
                    >
                      <button
                        type="button"
                        className="lc-agent-scope-option"
                        onClick={() => selectSubMark(mark)}
                      >
                        <span className="lc-footnote-overview-entry-text">{mark.excerpt}</span>
                      </button>
                      <button
                        type="button"
                        className="lc-footnote-overview-add lc-footnote-overview-row-remove"
                        aria-label={`Remove ${mark.kind}`}
                        onClick={() => removeSubMark(mark.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <HubSection
                title="Links"
                onAdd={() => openTask({ kind: "link", index: null })}
              >
                {(searchLink || userLinks.length > 0) && (
                  <ul className={listClass(userLinks.length + (searchLink ? 1 : 0))}>
                    {searchLink && (
                      <li>
                        <button
                          type="button"
                          className="lc-agent-scope-option"
                          onClick={() => onOpenExternal(searchLink.url)}
                        >
                          <strong>{searchLink.title}</strong>
                          <span className="lc-muted">{searchLink.url}</span>
                        </button>
                      </li>
                    )}
                    {userLinks.map((link, index) => (
                      <li key={`user-${index}-${link.url}`}>
                        <button
                          type="button"
                          className="lc-agent-scope-option"
                          onClick={() => openTask({ kind: "link", index })}
                        >
                          <strong>{link.title || link.url}</strong>
                          {link.title ? <span className="lc-muted">{link.url}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
              {onAddWorkspaceLink && (
                <HubSection title="Workspace links" onAdd={onAddWorkspaceLink}>
                  {workspaceLinks.length > 0 && (
                    <ul className={listClass(workspaceLinks.length)}>
                      {workspaceLinks.map((link) => (
                        <li key={link.edgeId}>
                          <HoldButton
                            label={link.title}
                            className="lc-agent-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
                            ariaLabel={`${link.title} — tap to open, hold to unlink`}
                            holdMs={HOLD_SENSITIVE_MS}
                            holdThrough
                            onTap={() => onOpenWorkspaceLink?.(link.edgeId)}
                            // Holding removes the *link*, never the thing it
                            // points at — the notebook on the other end is not
                            // this card's to delete.
                            onConfirm={() => onRemoveWorkspaceLink?.(link.edgeId)}
                          >
                            <strong className="lc-footnote-overview-entry-text">{link.title}</strong>
                            <span className="lc-muted">{link.kindLabel}</span>
                          </HoldButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </HubSection>
              )}
              {isAiTab ? (
                notes.length > 0 ? (
                  <HubSection title="Notes">
                    <ul className={listClass(notes.length)}>
                      {notes.map((note) => (
                        <li key={note.id}>
                          <span className="lc-agent-scope-option">
                            <strong className="lc-footnote-overview-entry-text">{note.text}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </HubSection>
                ) : null
              ) : (
              <HubSection title="Notes" onAdd={() => openTask({ kind: "note", id: null })}>
                {notes.length > 0 && (
                  <ul className={listClass(notes.length)}>
                    {notes.map((note) => (
                      <li key={note.id}>
                        <HoldButton
                          label={note.text}
                          className="lc-agent-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
                          ariaLabel={`${note.text} — tap to edit, hold to delete`}
                          holdMs={HOLD_SENSITIVE_MS}
                          holdThrough
                          onTap={() => openTask({ kind: "note", id: note.id })}
                          onConfirm={() =>
                            updateNotes(notes.filter((entry) => entry.id !== note.id))
                          }
                        >
                          <strong className="lc-footnote-overview-entry-text">{note.text}</strong>
                        </HoldButton>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
              )}
              <HubSection title="Threads">
                {threads.length > 0 && (
                  <ul className={listClass(threads.length)}>
                    {threads.map((thread) => (
                      <li key={thread.rootId}>
                        <button
                          type="button"
                          className="lc-agent-scope-option"
                          onClick={() => openTask({ kind: "thread", rootId: thread.rootId })}
                        >
                          <strong className="lc-footnote-overview-entry-text">{thread.title}</strong>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </>,
    document.body,
  );
}
/**
 * A hub list only becomes a scroller once it has a third row.
 *
 * Two rows always fit inside `max-height`, so turning the pane on for them
 * bought nothing and cost a scrollbar — which Windows Chromium decorates with
 * ↑↓ stepper tips however hard the stylesheet asks it not to.
 */
const SCROLL_AT = 3;

function listClass(count: number): string {
  return count >= SCROLL_AT
    ? "lc-footnote-overview-link-list lc-footnote-overview-scroll-list is-scrolling lc-scroll-pane"
    : "lc-footnote-overview-link-list";
}

function HubSection({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="lc-footnote-overview-section" aria-label={title}>
      <div className="lc-footnote-overview-section-head">
        <h3 className="lc-agent-turn-role">{title}</h3>
        {onAdd ? (
          <button
            type="button"
            className="lc-footnote-overview-add"
            aria-label={`Add ${title}`}
            onClick={onAdd}
          >
            +
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
function NoteTask({
  initial,
  onSave,
  onBack,
}: {
  initial: string;
  onSave: (text: string) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <textarea
        ref={ref}
        className="lc-footnote-bubble-note lc-footnote-overview-task-field"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Note"
        placeholder="Write a note…"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onBack();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          onSave(text);
        }}
      />
      <div className="lc-footnote-bubble-actions">
        <button type="button" className="lc-footnote-task-back" onClick={onBack}>
          Back
        </button>
        <button type="button" onClick={() => onSave(text)}>
          Save
        </button>
      </div>
    </>
  );
}
function LinkTask({
  initialUrl,
  initialTitle,
  onSave,
  onRemove,
  onBack,
}: {
  initialUrl: string;
  initialTitle: string;
  onSave: (url: string, title?: string) => void;
  onRemove?: () => void;
  onBack: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => onSave(url, title);
  return (
    <>
      <div className="lc-footnote-overview-add-link lc-footnote-overview-task-fields">
        <input
          ref={ref}
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Link URL"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Link title"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="lc-footnote-bubble-actions">
        <button type="button" className="lc-footnote-task-back" onClick={onBack}>
          Back
        </button>
        {onRemove && (
          <button
            type="button"
            className="lc-footnote-overview-add"
            aria-label="Remove link"
            onClick={onRemove}
          >
            ✕
          </button>
        )}
        <button type="button" onClick={submit} disabled={!url.trim()}>
          Save
        </button>
      </div>
    </>
  );
}
