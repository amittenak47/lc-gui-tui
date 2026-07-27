/**
 * Coach side panel — chat thread + composer (codebase-graph Ask-style).
 *
 * Draw / Review board are composer flags that ride along with Send, not
 * standalone actions. Structured results (review, tests, nudges) render
 * inside the message list as assistant turns.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Tip } from "../components/Tip";

export type CoachMode = "review" | "ambient";

export interface CoachSendFlags {
  /** Ask the coach to draw on the board. */
  draw: boolean;
  /** Attach the current board (and code dock) to the request. */
  reviewBoard: boolean;
}

export interface CoachChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
}

export interface AgentSidePanelProps {
  open: boolean;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  busy: boolean;
  thinking?: boolean;
  messages: CoachChatMessage[];
  onSend: (text: string, flags: CoachSendFlags) => void;
  /** Structured cards (review, tests, …) rendered in the thread. */
  children?: ReactNode;
}

export function AgentSidePanel({
  open,
  mode,
  onModeChange,
  busy,
  thinking = false,
  messages,
  onSend,
  children,
}: AgentSidePanelProps) {
  const [draft, setDraft] = useState("");
  const [draw, setDraw] = useState(false);
  const [reviewBoard, setReviewBoard] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, thinking, children, open]);

  if (!open) return null;

  const canSend = !busy && (draft.trim().length > 0 || draw || reviewBoard);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(draft.trim(), { draw, reviewBoard });
    setDraft("");
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
              <div className="lc-coach-turn-role">
                {message.role === "user" ? "You" : message.role === "system" ? "System" : "Coach"}
              </div>
              <div className="lc-coach-turn-body">{message.content}</div>
            </div>
          ))}
          {children}
          {thinking && (
            <div className="lc-coach-turn lc-coach-turn-assistant lc-coach-thinking" role="status">
              <div className="lc-coach-turn-role">Coach</div>
              <div className="lc-coach-turn-body">
                <span className="lc-coach-spinner" aria-hidden />
                Thinking…
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
              <Tip tip="Coach replies when you ask from the composer" placement="top">
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
              <Tip tip="Coach glances every 60s and nudges in this thread" placement="top">
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
              <Tip tip="When you Send, ask the coach to draw on the board" placement="top">
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
              <Tip tip="When you Send, attach the board and code dock" placement="top">
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
    </aside>
  );
}
