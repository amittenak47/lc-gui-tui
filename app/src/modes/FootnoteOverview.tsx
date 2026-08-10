import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CoachChatMessage } from "./AgentSidePanel";
import {
  freshNoteId,
  type DocFootnote,
  type DocFootnoteNote,
  type DocFootnoteUserLink,
} from "../util/docFootnotes";
import { fetchNextColorHuntPalette } from "../util/colorHunt";
import {
  appendInkPalette,
  currentInkPalette,
  seedInkPaletteHistory,
  type InkPaletteHistory,
} from "../util/inkPaletteHistory";
import { isSafeExternalUrl } from "../util/openExternal";

export interface FootnoteOverviewProps {
  footnote: DocFootnote;
  number?: number;
  /** The turns of one saved thread — the card asks per thread, as it opens them. */
  threadMessages: (rootId: string) => CoachChatMessage[];
  onClose: () => void;
  onChange: (next: DocFootnote) => void;
  /** `null` starts a new thread; a rootId continues that one. */
  onSendCoach: (text: string, threadRootId: string | null) => void;
  onOpenExternal: (url: string) => void;
  anchorRect?: DOMRect | null;
}

/**
 * What the side bubble is showing.
 *
 * One bubble, two contents: a note being written, or a thread being read and
 * replied to. They are the same gesture — an entry in a list opens beside the
 * card — so they are the same surface rather than two that drift apart.
 */
type Bubble =
  | { kind: "note"; id: string | null }
  | { kind: "thread"; rootId: string | null };

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

/**
 * Beside the card if there is room, under it if there is not.
 *
 * "To the side" is the point of the bubble — the list stays visible while an
 * entry is open, so it is obvious which entry you are editing. A phone that
 * cannot fit both across its width gets the bubble below instead of on top of
 * the card, because a bubble covering the list it came from is the thing this
 * layout exists to avoid.
 */
function placeBubble(node: HTMLElement, card: HTMLElement | null) {
  const gap = 6;
  const margin = 8;
  const { width: viewWidth, height: viewHeight, originX, originY } = viewport();
  const rect = card?.getBoundingClientRect();
  if (!rect) {
    settle(node, originX + viewWidth / 2 - node.offsetWidth / 2, originY + viewHeight / 2 - node.offsetHeight / 2);
    return;
  }

  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const toRight = rect.right + gap;
  const toLeft = rect.left - width - gap;

  if (toRight + width + margin <= originX + viewWidth) {
    settle(node, toRight, rect.top);
    return;
  }
  if (toLeft >= originX + margin) {
    settle(node, toLeft, rect.top);
    return;
  }
  const below = rect.bottom + gap;
  const top = below + height + margin > originY + viewHeight ? rect.top - height - gap : below;
  settle(node, rect.left, top);
}

/**
 * Footnote overview — doc-sheet chrome, user links only, mini coach thread.
 * Does not open the docked coach panel.
 */
export function FootnoteOverview({
  footnote,
  number,
  threadMessages,
  onClose,
  onChange,
  onSendCoach,
  onOpenExternal,
  anchorRect,
}: FootnoteOverviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [draft, setDraft] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  /**
   * A palette to choose from, seeded the way the ink wheel seeds its own.
   *
   * Local to the open card rather than persisted: what is worth keeping is the
   * colour the reader picked, which lives on the footnote. The palette is the
   * means, and asking for another one is a tap.
   */
  const [history, setHistory] = useState<InkPaletteHistory>(() => seedInkPaletteHistory("light"));
  const [shuffling, setShuffling] = useState(false);
  const palette = currentInkPalette(history);

  const userLinks = footnote.userLinks ?? [];
  const notes = footnote.notes ?? [];
  const threads = footnote.threads ?? [];
  /** Search footnotes keep their own URL — not auto-suggestions. */
  const searchLink =
    footnote.kind === "search" && footnote.url
      ? { title: footnote.query || "Search", url: footnote.url }
      : null;

  const place = useCallback(() => {
    if (panelRef.current) clampPanel(panelRef.current, anchorRect);
    if (bubbleRef.current) placeBubble(bubbleRef.current, panelRef.current);
  }, [anchorRect]);

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
  }, [place, bubble, notes.length, threads.length, userLinks.length]);

  const openThreadMessages = useMemo(
    () => (bubble?.kind === "thread" && bubble.rootId ? threadMessages(bubble.rootId) : []),
    [bubble, threadMessages],
  );

  useLayoutEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [openThreadMessages]);

  /*
   * A brand new thread has no id until the send comes back with one.
   *
   * The card asks for `null` and the app answers by adding a thread to the
   * footnote, so the bubble adopts whichever rootId it did not know about
   * before. Without this the reader sends a question and the bubble they sent
   * it from stays empty, which reads as the message having gone nowhere.
   */
  const knownRootsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (bubble?.kind !== "thread" || bubble.rootId) {
      knownRootsRef.current = new Set(threads.map((thread) => thread.rootId));
      return;
    }
    const fresh = threads.find((thread) => !knownRootsRef.current.has(thread.rootId));
    if (fresh) setBubble({ kind: "thread", rootId: fresh.rootId });
  }, [bubble, threads]);

  const updateNotes = (next: DocFootnoteNote[]) => {
    onChange({ ...footnote, notes: next.length > 0 ? next : undefined });
  };

  const saveNote = (text: string) => {
    if (bubble?.kind !== "note") return;
    const body = text.trim();
    const now = Date.now();
    if (!body) {
      // An emptied note is a deleted note; a blank box in the list is nothing.
      if (bubble.id) updateNotes(notes.filter((note) => note.id !== bubble.id));
      setBubble(null);
      return;
    }
    if (bubble.id) {
      updateNotes(
        notes.map((note) => (note.id === bubble.id ? { ...note, text: body, updatedAt: now } : note)),
      );
    } else {
      updateNotes([...notes, { id: freshNoteId(notes, now), text: body, createdAt: now, updatedAt: now }]);
    }
    setBubble(null);
  };

  const updateUserLinks = (next: DocFootnoteUserLink[]) => {
    onChange({ ...footnote, userLinks: next.length > 0 ? next : undefined });
  };

  const addUserLink = () => {
    const url = linkUrl.trim();
    if (!url || !isSafeExternalUrl(url)) return;
    updateUserLinks([...userLinks, { url }]);
    setLinkUrl("");
    setAddingLink(false);
  };

  const removeUserLink = (index: number) => {
    updateUserLinks(userLinks.filter((_, i) => i !== index));
  };

  const removeThread = (rootId: string) => {
    // The transcript itself is the coach's; the footnote only stops pointing
    // at it, the same way removing a link does not unpublish a page.
    const next = threads.filter((thread) => thread.rootId !== rootId);
    onChange({
      ...footnote,
      threads: next.length > 0 ? next : undefined,
      ...(footnote.threadRootId === rootId ? { threadRootId: next[0]?.rootId } : {}),
    });
    if (bubble?.kind === "thread" && bubble.rootId === rootId) setBubble(null);
  };

  const send = () => {
    if (bubble?.kind !== "thread") return;
    const text = draft.trim();
    if (!text) return;
    if (!bubble.rootId) knownRootsRef.current = new Set(threads.map((thread) => thread.rootId));
    onSendCoach(text, bubble.rootId);
    setDraft("");
  };

  const openBubble = (next: Bubble) => {
    setDraft("");
    setBubble(next);
  };

  const title =
    number != null
      ? `${number}. ${footnote.excerpt || "This area of the page"}`
      : footnote.excerpt || "This area of the page";

  const editing = bubble?.kind === "note" ? notes.find((note) => note.id === bubble.id) ?? null : null;

  return createPortal(
    <>
      {/*
        Closes on its own `pointerdown`, not on a click.

        A ribbon opens this card on the *release* of a tap, so the `click` that
        completes that very tap lands here — on a backdrop that did not exist
        when the tap began. On `onClick` the card opened and shut inside one
        tap, which reads as the panel refusing to stay open. A `pointerdown`
        can only come from a second, deliberate press.
      */}
      <button
        type="button"
        className="lc-doc-sheet-backdrop"
        aria-label={bubble ? "Close editor" : "Close footnote"}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          // One layer at a time: the bubble is on top, so it goes first.
          if (bubble) setBubble(null);
          else onClose();
        }}
        style={{ zIndex: 232 }}
      />
      <div
        className="lc-doc-sheet lc-footnote-overview"
        ref={panelRef}
        role="dialog"
        aria-label="Footnote"
        style={{ visibility: "hidden", zIndex: 233 }}
      >
        <p className="lc-doc-sheet-excerpt">{title}</p>

        {/*
          The ribbon's colour, from the palette wheel the ink already uses.

          Same mechanism, not a second one: `fetchNextColorHuntPalette` is what
          the board's colour wheel pulls from, so "another palette" here means
          exactly what it means there, and the offline fallback list is shared.
          Four swatches, because that is what a ColorHunt palette is.
        */}
        <section className="lc-footnote-overview-section" aria-label="Colour">
          <h3 className="lc-coach-turn-role">Colour</h3>
          <div className="lc-footnote-overview-swatches">
            {palette.map((color) => (
              <button
                key={color}
                type="button"
                className={`lc-footnote-overview-swatch${
                  footnote.color === color ? " is-active" : ""
                }`}
                style={{ background: color }}
                aria-label={`Colour this mark ${color}`}
                aria-pressed={footnote.color === color}
                title={color}
                onClick={() => onChange({ ...footnote, color })}
              />
            ))}
            <button
              type="button"
              className="lc-secondary"
              aria-label="Another palette"
              title="Another palette"
              disabled={shuffling}
              onClick={() => {
                setShuffling(true);
                void fetchNextColorHuntPalette(history)
                  .then((next) => setHistory((current) => appendInkPalette(current, next)))
                  .finally(() => setShuffling(false));
              }}
            >
              ⟳
            </button>
            {footnote.color && (
              <button
                type="button"
                className="lc-secondary"
                aria-label="Use the default colour"
                title="Use the default colour"
                onClick={() => {
                  const { color: _dropped, ...rest } = footnote;
                  onChange(rest);
                }}
              >
                Reset
              </button>
            )}
          </div>
        </section>

        <section className="lc-footnote-overview-section" aria-label="Links">
          <h3 className="lc-coach-turn-role">Links</h3>
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
              <li key={`user-${index}-${link.url}`} className="lc-footnote-overview-link-row">
                <button
                  type="button"
                  className="lc-coach-scope-option"
                  onClick={() => onOpenExternal(link.url)}
                >
                  <strong>{link.title || link.url}</strong>
                  {link.title ? <span className="lc-muted">{link.url}</span> : null}
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  aria-label="Remove link"
                  onClick={() => removeUserLink(index)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {addingLink ? (
            <div className="lc-footnote-overview-add-link">
              <input
                type="url"
                placeholder="https://…"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                aria-label="Link URL"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addUserLink();
                  }
                }}
              />
              <button type="button" onClick={addUserLink}>
                Add
              </button>
              <button
                type="button"
                className="lc-secondary"
                onClick={() => {
                  setAddingLink(false);
                  setLinkUrl("");
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="lc-secondary" onClick={() => setAddingLink(true)}>
              Add link
            </button>
          )}
        </section>

        {/*
          Notes, as entries.

          Each row is a box that opens what it holds; the buttons at its end
          edit and delete that one note. The list scrolls, so a mark with a
          dozen notes is the same height on the card as a mark with one.
        */}
        <section className="lc-footnote-overview-section" aria-label="Notes">
          <h3 className="lc-coach-turn-role">Notes</h3>
          <ul className="lc-footnote-overview-link-list">
            {notes.length === 0 && <li className="lc-muted lc-footnote-overview-empty">No notes yet.</li>}
            {notes.map((note) => (
              <li key={note.id} className="lc-footnote-overview-link-row">
                <button
                  type="button"
                  className={`lc-coach-scope-option${
                    bubble?.kind === "note" && bubble.id === note.id ? " is-open" : ""
                  }`}
                  onClick={() => openBubble({ kind: "note", id: note.id })}
                >
                  <strong className="lc-footnote-overview-entry-text">{note.text}</strong>
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  aria-label="Edit note"
                  title="Edit"
                  onClick={() => openBubble({ kind: "note", id: note.id })}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  aria-label="Delete note"
                  title="Delete"
                  onClick={() => {
                    updateNotes(notes.filter((entry) => entry.id !== note.id));
                    if (bubble?.kind === "note" && bubble.id === note.id) setBubble(null);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="lc-secondary"
            onClick={() => openBubble({ kind: "note", id: null })}
          >
            Add note
          </button>
        </section>

        {/* Threads, listed the same way — a conversation is an entry too. */}
        <section className="lc-footnote-overview-section" aria-label="Ask AI">
          <h3 className="lc-coach-turn-role">Ask AI</h3>
          <ul className="lc-footnote-overview-link-list">
            {threads.length === 0 && (
              <li className="lc-muted lc-footnote-overview-empty">No threads yet.</li>
            )}
            {threads.map((thread) => (
              <li key={thread.rootId} className="lc-footnote-overview-link-row">
                <button
                  type="button"
                  className={`lc-coach-scope-option${
                    bubble?.kind === "thread" && bubble.rootId === thread.rootId ? " is-open" : ""
                  }`}
                  onClick={() => openBubble({ kind: "thread", rootId: thread.rootId })}
                >
                  <strong className="lc-footnote-overview-entry-text">{thread.title}</strong>
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  aria-label="Forget thread"
                  title="Forget"
                  onClick={() => removeThread(thread.rootId)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="lc-secondary"
            onClick={() => openBubble({ kind: "thread", rootId: null })}
          >
            New thread
          </button>
        </section>
      </div>

      {bubble && (
        <div
          className="lc-doc-sheet lc-footnote-bubble"
          ref={bubbleRef}
          role="dialog"
          aria-label={bubble.kind === "note" ? "Note" : "Thread"}
          style={{ visibility: "hidden", zIndex: 234 }}
        >
          {bubble.kind === "note" ? (
            <NoteBubble
              key={editing?.id ?? "new"}
              initial={editing?.text ?? ""}
              onSave={saveNote}
              onCancel={() => setBubble(null)}
            />
          ) : (
            <>
              {/* Titled the way the card titles itself — this is what the
                  bubble is about, not a section label. */}
              <p className="lc-doc-sheet-excerpt">
                {bubble.rootId
                  ? threads.find((thread) => thread.rootId === bubble.rootId)?.title ?? "Thread"
                  : "New thread"}
              </p>
              <div className="lc-coach-messages lc-footnote-overview-thread" ref={transcriptRef}>
                {openThreadMessages.length === 0 ? (
                  <p className="lc-muted lc-footnote-overview-empty">No messages yet.</p>
                ) : (
                  openThreadMessages.map((message) => (
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
                  ))
                )}
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
                  placeholder="Ask…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    if (event.shiftKey) return;
                    event.preventDefault();
                    send();
                  }}
                  aria-label="Ask AI"
                />
                <div className="lc-coach-composer-bar">
                  <div className="lc-coach-composer-actions">
                    <button
                      type="button"
                      className="lc-secondary"
                      onClick={() => setBubble(null)}
                    >
                      Close
                    </button>
                    <button type="submit" disabled={draft.trim().length === 0}>
                      Send
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}

/**
 * The note editor — its own component so the text lives in it.
 *
 * Keyed by the note being edited, so opening a different entry remounts with
 * that entry's text rather than carrying the last one's over. Saving is
 * explicit: a note is not written back on every keystroke, which is what
 * makes Cancel mean something.
 */
function NoteBubble({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <>
      <h3 className="lc-coach-turn-role">{initial ? "Edit note" : "New note"}</h3>
      <textarea
        ref={ref}
        className="lc-footnote-bubble-note"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Note"
        placeholder="Write a note…"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          onSave(text);
        }}
      />
      <div className="lc-footnote-bubble-actions">
        <button type="button" className="lc-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => onSave(text)}>
          Save
        </button>
      </div>
    </>
  );
}
