import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type { CoachChatMessage } from "./AgentSidePanel";
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
import {
  advanceInkPalette,
  inkPaletteNow,
  onInkPaletteChange,
  retreatInkPalette,
} from "../canvas/inkPaletteBridge";
import { loadInkHandedness } from "../util/inkHandedness";
import { currentInkPalette } from "../util/inkPaletteHistory";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { isSafeExternalUrl } from "../util/openExternal";
import { HOLD_SENSITIVE_MS } from "../util/gesture";
export interface FootnoteOverviewProps {
  footnote: DocFootnote;
  number?: number;
  /** The turns of one saved thread — the card asks per thread, as it opens them. */
  threadMessages: (rootId: string) => CoachChatMessage[];
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
}
type Task =
  | { kind: "note"; id: string | null }
  | { kind: "thread"; rootId: string | null }
  | { kind: "link"; index: number | null };
function turnKind(role: CoachChatMessage["role"]): "user" | "assistant" | "system" | "app" {
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
function settle(node: HTMLElement, left: number, top: number) {
  const margin = 8;
  const { width: viewWidth, height: viewHeight, originX, originY } = viewport();
  const maxLeft = Math.max(margin, originX + viewWidth - node.offsetWidth - margin);
  const maxTop = Math.max(margin, originY + viewHeight - node.offsetHeight - margin);
  node.style.left = `${Math.round(Math.min(Math.max(originX + margin, left), maxLeft))}px`;
  node.style.top = `${Math.round(Math.min(Math.max(originY + margin, top), maxTop))}px`;
  node.style.visibility = "visible";
}
function clampPanel(node: HTMLElement, anchorRect: DOMRect | null | undefined) {
  const margin = 8;
  const { width: viewWidth, height: viewHeight, originX, originY } = viewport();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left: number;
  let top: number;
  if (anchorRect) {
    left = anchorRect.left + anchorRect.width / 2 - width / 2;
    const below = anchorRect.bottom + 6;
    top = below + height + margin > originY + viewHeight ? anchorRect.top - height - 6 : below;
  } else {
    left = originX + viewWidth / 2 - width / 2;
    top = originY + viewHeight / 2 - height / 2;
  }
  settle(node, left, top);
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
  anchorRect,
  subMarkMode,
  onSubMarkModeChange,
  openThreadRootId = null,
}: FootnoteOverviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [draft, setDraft] = useState("");
  const history = useSyncExternalStore(onInkPaletteChange, inkPaletteNow, inkPaletteNow);
  const palette = currentInkPalette(history);
  const handedness = loadInkHandedness();
  const markColor = footnote.color ?? palette[0] ?? "#0d9488";
  const userLinks = footnote.userLinks ?? [];
  const notes = footnote.notes ?? [];
  const threads = footnote.threads ?? [];
  const subMarks = footnote.subMarks ?? [];
  const searchLink =
    footnote.kind === "search" && footnote.url
      ? { title: footnote.query || "Search", url: footnote.url }
      : null;
  const subMarkArmed = Boolean(subMarkMode) && !task;
  const [copied, setCopied] = useState(false);
  const footnoteRef = useRef(footnote);
  footnoteRef.current = footnote;
  const paletteRef = useRef(palette);
  const paletteKey = palette.join("|").toLowerCase();

  useEffect(() => {
    if (!openThreadRootId) return;
    setTask({ kind: "thread", rootId: openThreadRootId });
  }, [openThreadRootId]);

  /*
   * Wheel cycle → same slot on the new set becomes mark colour, so the page
   * box wash + hub chrome rotate with the palette (not only the hub swatch).
   */
  useEffect(() => {
    const prev = paletteRef.current;
    paletteRef.current = palette;
    if (prev.join("|").toLowerCase() === paletteKey) return;
    const current = footnoteRef.current;
    const slot = current.color
      ? prev.findIndex(
          (swatch) => swatch.trim().toLowerCase() === current.color!.trim().toLowerCase(),
        )
      : 0;
    const next = palette[slot >= 0 ? slot : 0] ?? palette[0];
    if (!next) return;
    if (
      current.color &&
      current.color.trim().toLowerCase() === next.trim().toLowerCase()
    ) {
      return;
    }
    onChange({ ...current, color: next });
  }, [paletteKey, palette, onChange]);

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
          ".lc-footnote-overview, .lc-doc-sheet, .lc-doc-confirm, .lc-doc-selection-chrome, .lc-doc-submark-grip",
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
    applyViewportSize(node, task, subMarkArmed);
    clampPanel(node, anchorRect);
  }, [anchorRect, task, subMarkArmed]);
  useLayoutEffect(() => {
    place();
    const view = window.visualViewport;
    view?.addEventListener("resize", place);
    view?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => {
      view?.removeEventListener("resize", place);
      view?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [place, task, subMarkArmed, notes.length, threads.length, userLinks.length, subMarks.length]);
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
    const trimmed = url.trim();
    if (!trimmed || !isSafeExternalUrl(trimmed)) return;
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
    const next = subMarks.filter((mark) => mark.id !== id);
    onChange({ ...footnote, subMarks: next.length > 0 ? next : undefined });
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
    <LayoutGroup id={`footnote-hub-${footnote.id}`}>
      <button
        type="button"
        className="lc-doc-sheet-backdrop is-pass-through"
        aria-label={task ? "Back to footnote" : "Close footnote"}
        tabIndex={-1}
        style={{ zIndex: 232 }}
      />
      <motion.div
        layout
        layoutId="footnote-sheet"
        className={`lc-doc-sheet lc-footnote-overview${taskClass}${
          subMarkArmed ? " is-submark-armed" : ""
        }`}
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
        transition={{ layout: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {task?.kind === "note" ? (
            <motion.div
              key="task-note"
              className="lc-footnote-overview-task lc-footnote-overview-task-compact"
              layout
              layoutId="footnote-hub-body"
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
              layout
              layoutId="footnote-hub-body"
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
              layout
              layoutId="footnote-hub-body"
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
              <div className="lc-coach-messages lc-footnote-overview-thread" ref={transcriptRef}>
                {openThreadMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`lc-coach-turn lc-coach-turn-${turnKind(message.role)}`}
                  >
                    <div className="lc-coach-turn-role">
                      {turnKind(message.role) === "user" ? "You" : "Coach"}
                    </div>
                    <div className="lc-coach-turn-body">
                      {message.content || (message.pending ? "…" : "")}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="lc-coach-composer lc-footnote-overview-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <textarea
                  value={draft}
                  rows={1}
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
                <div className="lc-coach-composer-bar">
                  <div className="lc-coach-composer-actions">
                    <button type="submit" disabled={draft.trim().length === 0}>
                      Send
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          ) : (
            <motion.div
              key="hub"
              className="lc-footnote-overview-hub"
              layout
              layoutId="footnote-hub-body"
              {...taskMotion}
            >
              <header className="lc-footnote-overview-toolbar" aria-label="Mark style">
                <div className="lc-footnote-submark-modes" role="group" aria-label="Sub-mark mode">
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
                </div>
                <div className="lc-footnote-overview-color">
                  <ColorRadial
                    colors={palette}
                    value={markColor}
                    onPick={(color) => onChange({ ...footnote, color })}
                    onCycleNext={advanceInkPalette}
                    onCyclePrev={retreatInkPalette}
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
              {subMarkMode && (
                <p className="lc-muted lc-footnote-submark-hint">
                  Drag to select text in the mark. Adjust handles, then tap to confirm.
                </p>
              )}
              {!subMarkArmed && subMarks.length > 0 && (
                <ul className="lc-footnote-overview-link-list" aria-label="Sub-marks">
                  {subMarks.map((mark) => (
                    <li key={mark.id} className="lc-footnote-overview-link-row">
                      <span className="lc-coach-scope-option">
                        <strong>{mark.kind}</strong>
                        <span className="lc-muted">{mark.excerpt}</span>
                      </span>
                      <button
                        type="button"
                        className="lc-secondary"
                        aria-label={`Remove ${mark.kind}`}
                        onClick={() => removeSubMark(mark.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!subMarkArmed && (
                <>
              {onAttachCoach && (
                <button
                  type="button"
                  className="lc-footnote-chip is-active"
                  onClick={() => onAttachCoach(footnote.id)}
                >
                  Attach to chat
                </button>
              )}
              <HubSection
                title="Links"
                onAdd={() => openTask({ kind: "link", index: null })}
              >
                {(searchLink || userLinks.length > 0) && (
                  <ul className="lc-footnote-overview-link-list">
                    {searchLink && (
                      <li>
                        <button
                          type="button"
                          className="lc-coach-scope-option"
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
                          className="lc-coach-scope-option"
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
              <HubSection title="Notes" onAdd={() => openTask({ kind: "note", id: null })}>
                {notes.length > 0 && (
                  <ul className="lc-footnote-overview-link-list lc-footnote-overview-scroll-list lc-scroll-pane">
                    {notes.map((note) => (
                      <li key={note.id}>
                        <HoldButton
                          label={note.text}
                          className="lc-coach-scope-option lc-footnote-overview-entry-hold lc-hold-danger"
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
              <HubSection title="Threads">
                {threads.length > 0 && (
                  <ul className="lc-footnote-overview-link-list lc-footnote-overview-scroll-list lc-scroll-pane">
                    {threads.map((thread) => (
                      <li key={thread.rootId}>
                        <button
                          type="button"
                          className="lc-coach-scope-option"
                          onClick={() => openTask({ kind: "thread", rootId: thread.rootId })}
                        >
                          <strong className="lc-footnote-overview-entry-text">{thread.title}</strong>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </HubSection>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>,
    document.body,
  );
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
        <h3 className="lc-coach-turn-role">{title}</h3>
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
      <div className="lc-footnote-task-head">
        <button type="button" className="lc-secondary" onClick={onBack}>
          Back
        </button>
        <span className="lc-footnote-task-title">{initial ? "Edit note" : "New note"}</span>
      </div>
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
      <div className="lc-footnote-task-head">
        <button type="button" className="lc-secondary" onClick={onBack}>
          Back
        </button>
        <span className="lc-footnote-task-title">{initialUrl ? "Edit link" : "New link"}</span>
        {onRemove && (
          <button type="button" className="lc-secondary" aria-label="Remove link" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
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
          placeholder="Title (optional)"
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
        <button type="button" onClick={submit}>
          Save
        </button>
      </div>
    </>
  );
}
