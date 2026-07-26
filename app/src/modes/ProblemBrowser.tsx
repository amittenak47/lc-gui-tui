/**
 * The problem browser, organized the way the TUI is.
 *
 * Same table (q#, slug, difficulty, tags, cases), same 15-per-page paging, same
 * filters, and the same keys — `W`/`S` to move, `A`/`D` to page, `/` to search,
 * `T` tag, `E` difficulty, `O` sort, `R` random, `Enter` to open. Someone who
 * knows `lc` in the terminal already knows this screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LcClient } from "../api/client";
import type { ProblemSummary } from "../api/types";

export const PAGE_SIZE = 15;

const DIFFICULTIES = ["", "Easy", "Medium", "Hard"] as const;
const SORTS = ["task_id", "question", "difficulty", "cases", "tags"] as const;
const SORT_LABEL: Record<string, string> = {
  task_id: "slug",
  question: "q#",
  difficulty: "difficulty",
  cases: "cases",
  tags: "tags",
};

export interface ProblemBrowserProps {
  client: LcClient;
  onPick: (taskId: string) => void;
  busy: boolean;
}

/** Step through a cycle of options, wrapping — the TUI's T/E/O behaviour. */
export function cycle<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length];
}

export function ProblemBrowser({ client, onPick, busy }: ProblemBrowserProps) {
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const [sort, setSort] = useState<string>("task_id");
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<ProblemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .tags()
      .then((all) => !cancelled && setTags(all))
      .catch(() => {
        /* The filter is optional; a failure here shouldn't block browsing. */
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Any filter change resets to the first page — as in the TUI.
  useEffect(() => setPage(0), [query, difficulty, tag, sort]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      client
        .searchProblems({
          q: query || undefined,
          difficulty: difficulty || undefined,
          tag: tag || undefined,
          sort,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        })
        .then((result) => {
          if (cancelled) return;
          setRows(result.items);
          setTotal(result.total);
          setSelected((current) => Math.min(current, Math.max(result.items.length - 1, 0)));
          setError(null);
        })
        .catch((cause) => !cancelled && setError(messageOf(cause)))
        .finally(() => !cancelled && setLoading(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query, difficulty, tag, sort, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const move = useCallback(
    (delta: number) => {
      setSelected((current) => {
        const next = current + delta;
        if (next < 0 || next >= rows.length) return current;
        return next;
      });
    },
    [rows.length],
  );

  const turnPage = useCallback(
    (delta: number) => {
      setPage((current) => Math.min(Math.max(current + delta, 0), pageCount - 1));
      setSelected(0);
    },
    [pageCount],
  );

  const pickRandom = useCallback(async () => {
    try {
      const problem = await client.randomProblem({
        q: query || undefined,
        difficulty: difficulty || undefined,
        tag: tag || undefined,
      });
      if (problem) onPick(problem.task_id);
      else setError("no problems match the current filters");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, query, difficulty, tag, onPick]);

  // TUI keybindings. Ignored while typing in the search box, so `/`-then-text
  // behaves the way it does in the terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";

      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) {
        if (event.key === "Escape") (target as HTMLInputElement).blur();
        if (event.key === "Enter" && rows[selected]) onPick(rows[selected].task_id);
        return;
      }

      switch (event.key.toLowerCase()) {
        case "w":
          event.preventDefault();
          move(-1);
          break;
        case "s":
          event.preventDefault();
          move(1);
          break;
        case "a":
          event.preventDefault();
          turnPage(-1);
          break;
        case "d":
          event.preventDefault();
          turnPage(1);
          break;
        case "t":
          setTag((current) => cycle(["", ...tags], current));
          break;
        case "e":
          setDifficulty((current) => cycle(DIFFICULTIES as readonly string[], current));
          break;
        case "o":
          setSort((current) => cycle(SORTS as readonly string[], current));
          break;
        case "r":
          void pickRandom();
          break;
        case "enter":
          if (rows[selected]) onPick(rows[selected].task_id);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, turnPage, tags, rows, selected, onPick, pickRandom]);

  // Keep the highlighted row visible when moving with the keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const rangeLabel = useMemo(() => {
    if (total === 0) return "no matches";
    const first = page * PAGE_SIZE + 1;
    const last = Math.min(total, (page + 1) * PAGE_SIZE);
    return `${first}–${last} of ${total}`;
  }, [page, total]);

  return (
    <section className="lc-browser" aria-label="Browse problems">
      <div className="lc-browser-filters">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="/  slug, question number, or tag"
          aria-label="Search problems"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={difficulty}
          aria-label="Difficulty"
          onChange={(event) => setDifficulty(event.target.value)}
        >
          {DIFFICULTIES.map((value) => (
            <option key={value || "any"} value={value}>
              {value || "any difficulty"}
            </option>
          ))}
        </select>
        <select value={tag} aria-label="Tag" onChange={(event) => setTag(event.target.value)}>
          <option value="">any tag</option>
          {tags.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select value={sort} aria-label="Sort" onChange={(event) => setSort(event.target.value)}>
          {SORTS.map((value) => (
            <option key={value} value={value}>
              sort: {SORT_LABEL[value]}
            </option>
          ))}
        </select>
        <button type="button" className="lc-secondary" onClick={() => void pickRandom()}>
          Random
        </button>
      </div>

      {error && <p className="lc-warning">{error}</p>}

      <div className="lc-table-head" aria-hidden="true">
        <span className="lc-col-q">q#</span>
        <span className="lc-col-slug">task_id</span>
        <span className="lc-col-diff">difficulty</span>
        <span className="lc-col-tags">tags</span>
        <span className="lc-col-cases">cases</span>
      </div>

      <div className="lc-table" ref={listRef} role="listbox" aria-label="Problems" tabIndex={-1}>
        {rows.map((problem, index) => (
          <button
            key={problem.task_id}
            type="button"
            role="option"
            data-row={index}
            aria-selected={index === selected}
            className={index === selected ? "lc-row lc-row-selected" : "lc-row"}
            disabled={busy}
            onMouseEnter={() => setSelected(index)}
            onClick={() => onPick(problem.task_id)}
          >
            <span className="lc-col-q">{problem.question_id ?? ""}</span>
            <span className="lc-col-slug">{problem.task_id}</span>
            <span className={`lc-col-diff lc-diff-${(problem.difficulty ?? "").toLowerCase()}`}>
              {problem.difficulty ?? ""}
            </span>
            <span className="lc-col-tags">{problem.tags.join(", ")}</span>
            <span className="lc-col-cases">{problem.test_count}</span>
          </button>
        ))}
        {!loading && rows.length === 0 && (
          <p className="lc-muted lc-table-empty">
            No matches. If the corpus changed, run <code>lc index</code>.
          </p>
        )}
      </div>

      <div className="lc-browser-foot">
        <button type="button" className="lc-secondary" disabled={page === 0} onClick={() => turnPage(-1)}>
          ‹ prev
        </button>
        <span className="lc-muted">
          {rangeLabel} · page {page + 1}/{pageCount}
        </span>
        <button
          type="button"
          className="lc-secondary"
          disabled={page >= pageCount - 1}
          onClick={() => turnPage(1)}
        >
          next ›
        </button>
        <span className="lc-keys lc-muted">W/S move · A/D page · / search · T tag · E diff · O sort · R random · Enter open</span>
      </div>
    </section>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
