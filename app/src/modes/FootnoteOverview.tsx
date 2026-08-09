import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CoachChatMessage } from "./AgentSidePanel";
import { type DocFootnote, type DocFootnoteUserLink } from "../util/docFootnotes";
import { isSafeExternalUrl } from "../util/openExternal";

export interface FootnoteOverviewProps {
  footnote: DocFootnote;
  number?: number;
  messages: CoachChatMessage[];
  onClose: () => void;
  onChange: (next: DocFootnote) => void;
  onSendCoach: (text: string) => void;
  onOpenExternal: (url: string) => void;
  anchorRect?: DOMRect | null;
}

function turnKind(role: CoachChatMessage["role"]): "user" | "assistant" | "system" | "app" {
  if (role === "user" || role === "system" || role === "app") return role;
  return "assistant";
}

function clampPanel(node: HTMLElement, anchorRect: DOMRect | null | undefined) {
  const margin = 8;
  const view = window.visualViewport;
  const viewWidth = view?.width ?? window.innerWidth;
  const viewHeight = view?.height ?? window.innerHeight;
  const originX = view?.offsetLeft ?? 0;
  const originY = view?.offsetTop ?? 0;
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

  const maxLeft = Math.max(margin, originX + viewWidth - width - margin);
  const maxTop = Math.max(margin, originY + viewHeight - height - margin);
  node.style.left = `${Math.round(Math.min(Math.max(originX + margin, left), maxLeft))}px`;
  node.style.top = `${Math.round(Math.min(Math.max(originY + margin, top), maxTop))}px`;
  node.style.visibility = "visible";
}

/**
 * Footnote overview — doc-sheet chrome, user links only, mini coach thread.
 * Does not open the docked coach panel.
 */
export function FootnoteOverview({
  footnote,
  number,
  messages,
  onClose,
  onChange,
  onSendCoach,
  onOpenExternal,
  anchorRect,
}: FootnoteOverviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);

  const userLinks = footnote.userLinks ?? [];
  /** Search footnotes keep their own URL — not auto-suggestions. */
  const searchLink =
    footnote.kind === "search" && footnote.url
      ? { title: footnote.query || "Search", url: footnote.url }
      : null;

  const place = useCallback(() => {
    if (panelRef.current) clampPanel(panelRef.current, anchorRect);
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
  }, [place, messages.length, footnote.userNotes, userLinks.length]);

  useLayoutEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const updateNotes = (userNotes: string) => {
    onChange({ ...footnote, userNotes });
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

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSendCoach(text);
    setDraft("");
  };

  const title =
    number != null
      ? `${number}. ${footnote.excerpt || "This area of the page"}`
      : footnote.excerpt || "This area of the page";

  return createPortal(
    <>
      <button
        type="button"
        className="lc-doc-sheet-backdrop"
        aria-label="Close footnote"
        onClick={onClose}
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

        <section className="lc-footnote-overview-section" aria-label="Notes">
          <h3 className="lc-coach-turn-role">Notes</h3>
          <textarea
            className="lc-footnote-overview-notes"
            value={footnote.userNotes ?? ""}
            onChange={(event) => updateNotes(event.target.value)}
            rows={2}
            aria-label="Notes"
          />
        </section>

        <section
          className="lc-footnote-overview-section lc-footnote-overview-coach"
          aria-label="Ask AI"
        >
          <h3 className="lc-coach-turn-role">Ask AI</h3>
          <div className="lc-coach-messages lc-footnote-overview-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <p className="lc-muted lc-footnote-overview-empty">No messages yet.</p>
            ) : (
              messages.map((message) => (
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
                <button type="submit" disabled={draft.trim().length === 0}>
                  Send
                </button>
              </div>
            </div>
          </form>
        </section>
      </div>
    </>,
    document.body,
  );
}
