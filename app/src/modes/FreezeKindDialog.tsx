/**
 * Asked once per pad, at the freeze: is this a page, or a feed?
 *
 * I argued against asking, on the grounds that it would be abrasive. That was
 * wrong: freezing is already a deliberate act, so a question inside a decision
 * the reader is making anyway costs nothing, and it is asked per pad rather
 * than per visit.
 *
 * More importantly it buys something evidence cannot. The re-anchor count only
 * reacts to stranding that has *already happened* — a news homepage whose story
 * is still there today has every mark re-anchor, so evidence says "same
 * document", replaces, and throws away the one capture those marks could have
 * lived on. Tomorrow the story rotates off and that capture is gone.
 *
 * A wrong answer is self-correcting rather than lossy. Say "a page" about
 * something that turns out to be a feed and the first stranding keeps the old
 * capture anyway; say "a feed" about a static page and you accumulate captures
 * the retention rule then drops, because no mark is stranded on them.
 */

import { useEffect, useRef } from "react";

import type { WebPadKind } from "../util/webCaptures";

export interface FreezeKindDialogProps {
  url: string;
  /** The pre-selected answer, from the shape of the address. A guess, offered. */
  suggested: WebPadKind;
  onChoose: (kind: WebPadKind) => void;
  onCancel: () => void;
}

export function FreezeKindDialog({
  url,
  suggested,
  onChoose,
  onCancel,
}: FreezeKindDialogProps) {
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="lc-freeze-kind-scrim" role="presentation" onClick={onCancel}>
      <div
        className="lc-freeze-kind"
        role="dialog"
        aria-modal="true"
        aria-label="What kind of page is this?"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>What is this address?</h2>
        <p className="lc-freeze-kind-url">{url}</p>
        <p className="lc-freeze-kind-why">
          It decides what happens the next time you freeze it. A page is
          replaced; a feed keeps the version each mark was made on, because
          tomorrow’s feed holds none of today’s posts.
        </p>
        <div className="lc-freeze-kind-row">
          <button
            ref={suggested === "page" ? firstRef : undefined}
            type="button"
            className={
              suggested === "page"
                ? "lc-freeze-kind-pick is-suggested"
                : "lc-freeze-kind-pick"
            }
            onClick={() => onChoose("page")}
          >
            <b>A page</b>
            <span>An article, a post, a document. Re-freezing updates it.</span>
          </button>
          <button
            ref={suggested === "feed" ? firstRef : undefined}
            type="button"
            className={
              suggested === "feed"
                ? "lc-freeze-kind-pick is-suggested"
                : "lc-freeze-kind-pick"
            }
            onClick={() => onChoose("feed")}
          >
            <b>A feed</b>
            <span>A timeline, a front page, a search. Each freeze is kept.</span>
          </button>
        </div>
        <button type="button" className="lc-freeze-kind-cancel" onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  );
}
