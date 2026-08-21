/**
 * Header chip for the document index — morphs into a card about embedding.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DocIndexStatus } from "../api/client";
import { MorphBar } from "./MorphBar";

export type DocIndexChipStatus = "idle" | "indexing" | "indexed" | "error";

/** Done over total, in whatever unit the job counts. */
export interface DocWorkProgress {
  done: number;
  total: number;
}

/**
 * A ring with the number inside it, or a sweep when there is no number.
 *
 * `stroke-dasharray` on a circle, no library. The sweep matters: before the
 * first measurement there is genuinely nothing to report, and a ring showing
 * "0%" or an invented figure would be claiming otherwise.
 */
function WorkRing({ progress }: { progress: DocWorkProgress | null }) {
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
      : null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="lc-doc-index-ring" aria-hidden>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <circle cx="8" cy="8" r={radius} className="lc-doc-index-ring-track" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          className={pct == null ? "lc-doc-index-ring-arc is-sweeping" : "lc-doc-index-ring-arc"}
          strokeDasharray={
            pct == null
              ? `${circumference * 0.25} ${circumference}`
              : `${(circumference * pct) / 100} ${circumference}`
          }
        />
      </svg>
      {pct != null && <b className="lc-doc-index-ring-pct">{pct}</b>}
    </span>
  );
}

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
  /** Run or resume the embedding pass. Absent when there is nothing to embed. */
  onEmbed?: (() => void) | null;
  /** Pages extracted, while chunking. */
  indexProgress?: DocWorkProgress | null;
  /** Chunks embedded, while the pass runs. */
  embedProgress?: DocWorkProgress | null;
  /** A measured remaining time, never a guessed one. */
  embedEta?: string | null;
  /** The pass is running now. */
  embedding?: boolean;
  /**
   * Why indexing is not on offer right now, in the reader's words.
   *
   * A live page is the case this exists for. Indexing reads the pad's stored
   * text — the frozen copy — and while you are browsing that copy is whatever
   * was frozen last, which after three clicks is a different page from the one
   * on screen. Pressing `index` there did work and indexed something else, so
   * the chip has to say what it would have done rather than quietly doing it.
   */
  blocked?: string | null;
  /** Index disagreed with the hub; re-index stays on offer. */
  syncIssue?: string | null;
}

export function DocIndexChip({
  status,
  meta,
  error,
  onIndex,
  onEmbed,
  indexProgress,
  embedProgress,
  embedEta,
  embedding,
  blocked,
  syncIssue,
}: DocIndexChipProps) {
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
    if (blocked) {
      return (
        <span className="lc-doc-index-chip is-offer is-blocked" title={blocked}>
          index
        </span>
      );
    }
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
    return (
      <span className="lc-doc-index-chip is-working">
        <WorkRing progress={indexProgress ?? null} />
        indexing…
      </span>
    );
  }
  if (embedding) {
    return (
      <span
        className="lc-doc-index-chip is-working"
        title={embedEta ?? "Embedding — the estimate appears after the first batch."}
      >
        <WorkRing progress={embedProgress ?? null} />
        embedding…
      </span>
    );
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
  /*
   * Why it is not embedded, in the words the route worked out.
   *
   * "No model configured", "pending" and "embedded with X, now using Y" want
   * three different things done about them, and a chip that says only "words"
   * leaves the reader to guess which they are looking at.
   */
  const reason = meta?.reason ?? null;
  const staleModel =
    meta?.embed_model != null &&
    meta.embed_model.length > 0 &&
    meta.configured_model != null &&
    meta.configured_model.length > 0 &&
    meta.embed_model !== meta.configured_model;
  const canEmbed =
    wordsOnly && onEmbed != null && (meta?.configured_model ?? "").length > 0;

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
                  <div>
                    <dt>Embedded</dt>
                    <dd>
                      {meta?.chunks_total
                        ? `${meta.chunks_embedded ?? 0} of ${meta.chunks_total}`
                        : "—"}
                    </dd>
                  </div>
                </dl>
                {wordsOnly && (
                  <>
                    <p className="lc-doc-index-lead">
                      {staleModel
                        ? `These vectors were made by ${meta?.embed_model}, and ${meta?.configured_model} is configured now. Vectors from two models cannot be compared, so this document needs embedding again.`
                        : canEmbed
                          ? "Chunks are stored but not yet embedded, so they are matched on the words they share with your question rather than what it means."
                          : "No embedding model is set, so chunks are matched on the words they share with your question rather than what it means. Set one under Settings → LLM."}
                    </p>
                    {reason && !staleModel && !canEmbed && (
                      <p className="lc-doc-index-lead lc-muted">{reason}</p>
                    )}
                    {syncIssue && (
                      <p className="lc-doc-index-lead lc-muted">{syncIssue}</p>
                    )}
                    {canEmbed && onEmbed && (
                      <button
                        type="button"
                        className="lc-doc-index-redo"
                        onClick={() => {
                          setOpen(false);
                          onEmbed();
                        }}
                      >
                        {staleModel ? "Embed again with this model" : "Embed this document"}
                      </button>
                    )}
                    {onIndex &&
                      (blocked ? (
                        <p className="lc-doc-index-lead lc-muted">{blocked}</p>
                      ) : (
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
                      ))}
                  </>
                )}
                {!wordsOnly && syncIssue && (
                  <>
                    <p className="lc-doc-index-lead lc-muted">{syncIssue}</p>
                    {onIndex && !blocked && (
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
