/**
 * Header chip for the document index — morphs into a card about embedding.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DocIndexStatus } from "../api/client";
import { MorphBar } from "./MorphBar";

export type DocIndexChipStatus = "idle" | "indexing" | "indexed" | "error";

export interface DocIndexChipProps {
  status: DocIndexChipStatus;
  meta: DocIndexStatus | null;
  error: string | null;
  /**
   * Put this document in the index.
   *
   * Present only for the two kinds that do not index themselves — a web page
   * and a note you are writing. Both are things you might be finished with, and
   * neither can be guessed at: a page is a glance, and a draft is not a
   * document until its author says so.
   */
  onIndex?: (() => void) | null;
}

export function DocIndexChip({ status, meta, error, onIndex }: DocIndexChipProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (status !== "indexed") setOpen(false);
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status === "idle") {
    if (!onIndex) return null;
    return (
      <button
        type="button"
        className="lc-doc-index-chip is-offer"
        title="Index this document so the agent can search it"
        onClick={onIndex}
      >
        index
      </button>
    );
  }
  // `onIndex` is also the re-index action once a document is already in — the
  // work is identical, `upsert` deletes and rewrites.
  if (status === "indexing") {
    return <span className="lc-doc-index-chip">indexing…</span>;
  }
  if (status === "error") {
    return (
      <span className="lc-doc-index-chip is-bad" title={error ?? "index error"}>
        index error
      </span>
    );
  }

  const chunks = meta?.chunk_count ?? 0;
  const pages = meta?.page_count ?? 0;
  /*
   * Indexed is not the same as searchable-by-meaning.
   *
   * Every chunk carries a vector — that column is never empty. `embedded` says
   * what the vector is *made of*: a real model's, or the 64-bucket word-count
   * fallback that stands in when no embedding model is configured. Cosine over
   * word-counts finds chunks that share your words, not your question, and
   * nothing on screen said so.
   */
  const wordsOnly = meta != null && meta.embedded === false;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={wordsOnly ? "lc-doc-index-chip is-words" : "lc-doc-index-chip is-ok"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          const box = buttonRef.current?.getBoundingClientRect();
          if (box) setAnchor({ top: box.bottom + 8, left: box.left });
          setOpen((current) => !current);
        }}
      >
        {wordsOnly ? "indexed · words" : "indexed"}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className={open ? "lc-doc-index-pop is-open" : "lc-doc-index-pop"}
            style={
              anchor
                ? { top: anchor.top, left: Math.max(8, anchor.left) }
                : undefined
            }
          >
            <MorphBar
              active={open ? "card" : "idle"}
              axis="height"
              className="lc-doc-index-morph"
              role="dialog"
              aria-label="Document index"
            >
              <div data-morph-id="idle" />
              <aside data-morph-id="card" className="lc-doc-index-card">
                <p className="lc-doc-index-lead">
                  This snapshot’s text is in the local doc index. Ask and the
                  agent can retrieve chunks from it — not from the live page.
                </p>
                <dl className="lc-doc-index-grid">
                  <div>
                    <dt>Chunks</dt>
                    <dd>{chunks}</dd>
                  </div>
                  <div>
                    <dt>Pages</dt>
                    <dd>{pages || 1}</dd>
                  </div>
                  <div>
                    <dt>Matching</dt>
                    <dd>{meta?.embedded ? "by meaning" : "by words"}</dd>
                  </div>
                </dl>
                {wordsOnly && (
                  <>
                    <p className="lc-doc-index-lead">
                      No embedding model is set, so chunks are matched on the
                      words they share with your question rather than what it
                      means. Set one under Settings → LLM, then re-index.
                    </p>
                    {onIndex && (
                      <button
                        type="button"
                        className="lc-doc-index-redo"
                        onClick={() => {
                          setOpen(false);
                          onIndex();
                        }}
                      >
                        Re-index this document
                      </button>
                    )}
                  </>
                )}
              </aside>
            </MorphBar>
          </div>,
          document.body,
        )}
    </>
  );
}
