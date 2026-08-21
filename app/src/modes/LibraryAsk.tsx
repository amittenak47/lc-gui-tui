/**
 * Ask the library, from the view that is about everything.
 *
 * Explore is where this belongs: every other Ask is asked with one document
 * open and is usually about that document, so widening those would spend the
 * retrieval budget on other people's pages. Explore is already the map of the
 * whole shelf, and a question asked here is a question about the shelf.
 *
 * The scope line is not decoration and is not optional (§3c). An answer drawn
 * from nine of fourteen documents reads exactly like an answer drawn from all
 * fourteen unless it says otherwise — and on a second device, part-way through
 * its embedding pass, that difference is the whole story.
 */

import { useCallback, useRef, useState } from "react";

import type { LcClient, LibraryAnswer, LibraryHit } from "../api/client";
import { messageOf } from "../util/messageOf";

export interface LibraryAskProps {
  client: LcClient;
  /** Open the document a passage came from, by its content hash. */
  onOpenHash?: (hash: string, name: string) => void;
}

function snippet(text: string, max = 240): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function LibraryAsk({ client, onOpenHash }: LibraryAskProps) {
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState<LibraryAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  const ask = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const gen = ++genRef.current;
      setBusy(true);
      setError(null);
      try {
        const next = await client.retrieveLibrary(trimmed);
        if (genRef.current !== gen) return;
        setAnswer(next);
      } catch (cause) {
        if (genRef.current !== gen) return;
        setError(messageOf(cause));
        setAnswer(null);
      } finally {
        if (genRef.current === gen) setBusy(false);
      }
    },
    [client],
  );

  return (
    <section className="lc-library-ask" aria-label="Search your library">
      <form
        className="lc-library-ask-row"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <input
          type="search"
          value={draft}
          placeholder="Which of my documents talks about…"
          aria-label="Search every indexed document"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="lc-library-ask-go" disabled={busy || !draft.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="lc-library-ask-bad">{error}</p>}

      {answer && (
        <>
          {answer.chunks.length === 0 ? (
            <p className="lc-library-ask-empty">Nothing matched.</p>
          ) : (
            <ol className="lc-library-ask-hits">
              {answer.chunks.map((hit: LibraryHit, index) => (
                <li key={`${hit.hash}:${hit.page}:${index}`}>
                  <button
                    type="button"
                    className="lc-library-ask-hit"
                    onClick={() => onOpenHash?.(hit.hash, hit.name)}
                    disabled={!onOpenHash}
                  >
                    <span className="lc-library-ask-where">
                      <b>{hit.name}</b>
                      <span className="lc-library-ask-page">
                        page {hit.page}
                        {hit.heading ? ` · ${hit.heading}` : ""}
                      </span>
                    </span>
                    <span className="lc-library-ask-text">{snippet(hit.text)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {/*
            Said every time, including when everything was searched. A line that
            only appears when something is wrong teaches the reader to read its
            absence as "all of it" — which is exactly the assumption that is
            false on a device half-way through its embedding pass.
          */}
          <p className="lc-library-ask-scope">{answer.summary}</p>
        </>
      )}
    </section>
  );
}
