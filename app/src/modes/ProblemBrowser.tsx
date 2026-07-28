/**
 * The problem browser, organized the way the TUI is.
 *
 * Same table (q#, slug, difficulty, tags, cases), same 15-per-page paging, same
 * filters, and the same keys — `W`/`S` to move, `A`/`D` to page, `/` to search,
 * `T` tag, `E` difficulty, `O` sort, `G` dataset, `R` randomize session,
 * `M` select mode, `Space` add to session picks, `X` reset session, `Enter` to
 * open.
 *
 * The tab strip above the table switches problem sets. Everything below it —
 * filters, paging, session controls — works the same whichever tab is active;
 * the dataset is just another parameter on the same queries. Filters do reset
 * on a tab change, because a KodCode tag means nothing in the LeetCode tables.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LcClient, SearchOptions } from "../api/client";
import type { DatasetInfo, ProblemSummary, SessionSnapshot } from "../api/types";
import { DEFAULT_DATASET } from "../api/types";
import { BackgroundPalette } from "../components/BackgroundPalette";
import { titleFromSlug } from "../util/text";

export const PAGE_SIZE = 15;

const DIFFICULTIES = ["", "Easy", "Medium", "Hard"] as const;
const SORTS = ["task_id", "question", "difficulty", "cases", "tags"] as const;
const SORT_LABEL: Record<string, string> = {
  task_id: "name",
  question: "q#",
  difficulty: "difficulty",
  cases: "cases",
  tags: "tags",
};

export interface ProblemBrowserProps {
  client: LcClient;
  /** Opens a problem; `bank` is the active filter so header prev/next can walk the corpus. */
  onPick: (taskId: string, bank?: SearchOptions) => void;
  busy: boolean;
  themeId: string;
  onThemePick: (id: string) => void;
  session?: SessionSnapshot | null;
  /**
   * Start a session with the given picks (empty = fresh empty queue).
   *
   * `bank` carries the active tab, so the queue is enqueued against the
   * problem set the picks actually came from rather than whichever one the
   * app last opened a problem in.
   */
  onStartSession?: (taskIds: string[], bank: SearchOptions) => void;
  onResetSession?: () => void;
  /** Build a random session queue from current filters (Random button / R). */
  onRandomSession?: (bank: SearchOptions) => void;
}

/** Step through a cycle of options, wrapping — the TUI's T/E/O behaviour. */
export function cycle<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length];
}

export function ProblemBrowser({
  client,
  onPick,
  busy,
  themeId,
  onThemePick,
  session = null,
  onStartSession,
  onResetSession,
  onRandomSession,
}: ProblemBrowserProps) {
  const [dataset, setDataset] = useState<string>(DEFAULT_DATASET);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
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
  /** False until the first search returns — avoids filters-then-table flash. */
  const [tableReady, setTableReady] = useState(false);
  const tableReadyRef = useRef(false);
  /** Multi-select mode: clicks toggle picks instead of opening. */
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .tags(dataset)
      .then((all) => !cancelled && setTags(all))
      .catch(() => {
        /* The filter is optional; a failure here shouldn't block browsing. */
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataset]);

  useEffect(() => {
    let cancelled = false;
    void client
      .datasets()
      .then((all) => !cancelled && setDatasets(all))
      .catch(() => {
        // An older daemon has no /datasets — fall back to the single tab.
        if (!cancelled) setDatasets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Any filter change resets to the first page — as in the TUI.
  useEffect(() => setPage(0), [query, difficulty, tag, sort, dataset]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Debounce typing/filter changes; fetch immediately on first open.
    const delay = tableReadyRef.current ? 200 : 0;
    const timer = setTimeout(() => {
      client
        .searchProblems({
          dataset,
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
          tableReadyRef.current = true;
          setTableReady(true);
        })
        .catch((cause) => {
          if (cancelled) return;
          setError(messageOf(cause));
          tableReadyRef.current = true;
          setTableReady(true);
        })
        .finally(() => !cancelled && setLoading(false));
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, dataset, query, difficulty, tag, sort, page]);

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

  const bankFilters = useMemo(
    (): SearchOptions => ({
      dataset,
      q: query || undefined,
      difficulty: difficulty || undefined,
      tag: tag || undefined,
      sort: sort || undefined,
    }),
    [dataset, query, difficulty, tag, sort],
  );

  /**
   * Switch problem set. Tag and difficulty are corpus-specific, and a stale
   * tag would silently show an empty table on the new tab, so they clear.
   */
  const switchDataset = useCallback(
    (next: string) => {
      if (next === dataset) return;
      setDataset(next);
      setTag("");
      setDifficulty("");
      setTags([]);
      setPage(0);
      setSelected(0);
      setPicked(new Set());
      setSelectMode(false);
    },
    [dataset],
  );

  const pick = useCallback(
    (taskId: string) => onPick(taskId, bankFilters),
    [onPick, bankFilters],
  );

  const togglePick = useCallback((taskId: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const activateRow = useCallback(
    (taskId: string) => {
      if (selectMode) togglePick(taskId);
      else pick(taskId);
    },
    [selectMode, togglePick, pick],
  );

  const commitStart = useCallback(() => {
    onStartSession?.([...picked], bankFilters);
    setPicked(new Set());
    setSelectMode(false);
  }, [onStartSession, picked, bankFilters]);

  const commitReset = useCallback(() => {
    onResetSession?.();
    setPicked(new Set());
    setSelectMode(false);
  }, [onResetSession]);

  const randomizeSession = useCallback(() => {
    onRandomSession?.(bankFilters);
    setPicked(new Set());
    setSelectMode(false);
  }, [onRandomSession, bankFilters]);

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
        if (event.key === "Enter" && rows[selected]) pick(rows[selected].task_id);
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
        case "g": {
          event.preventDefault();
          const ids = datasets.length > 0 ? datasets.map((d) => d.id) : [DEFAULT_DATASET];
          switchDataset(cycle(ids, dataset));
          break;
        }
        case "r":
          event.preventDefault();
          randomizeSession();
          break;
        case "m":
          event.preventDefault();
          setSelectMode((on) => !on);
          break;
        case " ":
          event.preventDefault();
          if (rows[selected]) togglePick(rows[selected].task_id);
          if (!selectMode) setSelectMode(true);
          break;
        case "x":
          event.preventDefault();
          commitReset();
          break;
        case "enter":
          if (rows[selected]) pick(rows[selected].task_id);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    move,
    turnPage,
    tags,
    rows,
    selected,
    pick,
    randomizeSession,
    togglePick,
    selectMode,
    commitReset,
    datasets,
    dataset,
    switchDataset,
  ]);

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
      <div className="lc-browser-center">
        {!tableReady ? (
          <div className="lc-browser-loading" role="status" aria-live="polite" aria-label="Loading problems">
            <div className="lc-spinner" aria-hidden="true" />
          </div>
        ) : (
          <div className="lc-browser-body lc-browser-body-ready">
            <DatasetTabs
              datasets={datasets}
              active={dataset}
              disabled={busy}
              onPick={switchDataset}
            />
            <div className="lc-browser-filters">
              <input
                ref={searchRef}
                type="search"
                className="lc-tip-target"
                value={query}
                placeholder="/  name, question number, or tag"
                aria-label="Search problems"
                data-tip="Search by name, question number, or tag — press / to focus"
                data-tip-placement="bottom"
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="lc-tip-target"
                value={difficulty}
                aria-label="Difficulty"
                data-tip="Filter by difficulty — press E to cycle"
                data-tip-placement="bottom"
                onChange={(event) => setDifficulty(event.target.value)}
              >
                {DIFFICULTIES.map((value) => (
                  <option key={value || "any"} value={value}>
                    {value || "any difficulty"}
                  </option>
                ))}
              </select>
              <select
                className="lc-tip-target"
                value={tag}
                aria-label="Tag"
                data-tip="Filter by topic tag — press T to cycle"
                data-tip-placement="bottom"
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">any tag</option>
                {tags.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                className="lc-tip-target"
                value={sort}
                aria-label="Sort"
                data-tip="Sort column — press O to cycle"
                data-tip-placement="bottom"
                onChange={(event) => setSort(event.target.value)}
              >
                {SORTS.map((value) => (
                  <option key={value} value={value}>
                    sort: {SORT_LABEL[value]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="lc-secondary lc-tip-target"
                data-tip="Random session from filters — R"
                data-tip-placement="bottom"
                disabled={busy || !onRandomSession}
                onClick={randomizeSession}
              >
                Random
              </button>
            </div>

            {error && <p className="lc-warning">{error}</p>}

            <div className={loading ? "lc-browser-results lc-browser-results-pending" : "lc-browser-results"}>
              <div className="lc-table-head" aria-hidden="true">
                <span className="lc-col-q lc-tip-target" data-tip="LeetCode question number" data-tip-placement="bottom">
                  q#
                </span>
                <span className="lc-col-name lc-tip-target" data-tip="Problem name" data-tip-placement="bottom">
                  name
                </span>
                <span className="lc-col-diff lc-tip-target" data-tip="Easy, Medium, or Hard" data-tip-placement="bottom">
                  difficulty
                </span>
                <span className="lc-col-tags lc-tip-target" data-tip="Topic tags from the corpus" data-tip-placement="bottom">
                  tags
                </span>
                <span className="lc-col-cases lc-tip-target" data-tip="Number of test cases" data-tip-placement="bottom">
                  cases
                </span>
              </div>

              <div
                className={selectMode ? "lc-table lc-table-selecting" : "lc-table"}
                ref={listRef}
                role="listbox"
                aria-label="Problems"
                aria-multiselectable={selectMode}
                tabIndex={-1}
              >
                {rows.map((problem, index) => {
                  const isPicked = picked.has(problem.task_id);
                  const rowClass = [
                    "lc-row",
                    index === selected ? "lc-row-selected" : "",
                    isPicked ? "lc-row-picked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={problem.task_id}
                      type="button"
                      role="option"
                      data-row={index}
                      aria-selected={selectMode ? isPicked : index === selected}
                      className={rowClass}
                      disabled={busy || loading}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => activateRow(problem.task_id)}
                    >
                      <span className="lc-col-q">{problem.question_id ?? ""}</span>
                      <span className="lc-col-name" title={problem.task_id}>
                        {selectMode && (
                          <span className={isPicked ? "lc-pick-mark is-on" : "lc-pick-mark"} aria-hidden="true">
                            {isPicked ? "✓" : "○"}
                          </span>
                        )}
                        {titleFromSlug(problem.task_id)}
                        {/* Keyed on `dataset/task_id`, so a fail earned in one
                            problem set never badges the same slug in another. */}
                        {session?.problems[problem.key] && (
                          <span
                            className={`lc-session-badge is-${session.problems[problem.key].state}`}
                          >
                            {session.problems[problem.key].state === "passed"
                              ? "pass"
                              : session.problems[problem.key].state === "failed"
                                ? "fail"
                                : "ld"}
                          </span>
                        )}
                      </span>
                      <span className={`lc-col-diff lc-diff-${(problem.difficulty ?? "").toLowerCase()}`}>
                        {problem.difficulty ?? ""}
                      </span>
                      <span className="lc-col-tags">{problem.tags.join(", ")}</span>
                      <span className="lc-col-cases">{problem.test_count}</span>
                    </button>
                  );
                })}
                {!loading && rows.length === 0 && <EmptyTable dataset={dataset} datasets={datasets} />}
              </div>

              <div className="lc-browser-foot">
                <div className="lc-browser-foot-session">
                  <span className="lc-browser-foot-label">Session</span>
                  <button
                    type="button"
                    className="lc-secondary lc-tip-target"
                    disabled={busy || !onStartSession}
                    data-tip={
                      picked.size > 0
                        ? `Start session with ${picked.size} selected`
                        : "Start a fresh empty session"
                    }
                    data-tip-placement="top"
                    onClick={commitStart}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="lc-secondary lc-tip-target"
                    disabled={busy || !onResetSession}
                    data-tip="Clear session queue and progress — press X"
                    data-tip-placement="top"
                    onClick={commitReset}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className={
                      selectMode
                        ? "lc-secondary lc-tip-target is-active"
                        : "lc-secondary lc-tip-target"
                    }
                    disabled={busy}
                    data-tip="Toggle select mode — click rows or press Space to add — press M"
                    data-tip-placement="top"
                    aria-pressed={selectMode}
                    onClick={() => setSelectMode((on) => !on)}
                  >
                    Select{picked.size > 0 ? ` (${picked.size})` : ""}
                  </button>
                  <div className="lc-browser-foot-nav">
                    <button
                      type="button"
                      className="lc-secondary lc-tip-target"
                      disabled={page === 0 || loading}
                      data-tip="Previous page — press A"
                      data-tip-placement="top"
                      onClick={() => turnPage(-1)}
                    >
                      ‹ prev
                    </button>
                    <span className="lc-muted lc-tip-target" data-tip="Current page within filtered results" data-tip-placement="top">
                      {rangeLabel} · page {page + 1}/{pageCount}
                    </span>
                    <button
                      type="button"
                      className="lc-secondary lc-tip-target"
                      disabled={page >= pageCount - 1 || loading}
                      data-tip="Next page — press D"
                      data-tip-placement="top"
                      onClick={() => turnPage(1)}
                    >
                      next ›
                    </button>
                  </div>
                </div>
                <div className="lc-browser-foot-keys">
                  <span className="lc-keys lc-muted">
                    <span className="lc-tip-target" data-tip="Move highlight up or down" data-tip-placement="top">
                      W/S move
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Previous / next page" data-tip-placement="top">
                      A/D page
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Focus the search box" data-tip-placement="top">
                      / search
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Cycle topic tag filter" data-tip-placement="top">
                      T tag
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Cycle difficulty filter" data-tip-placement="top">
                      E diff
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Cycle sort column" data-tip-placement="top">
                      O sort
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Switch problem set" data-tip-placement="top">
                      G dataset
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Randomize session from filters" data-tip-placement="top">
                      R random
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Toggle select mode" data-tip-placement="top">
                      M select
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Add/remove highlighted problem from session picks" data-tip-placement="top">
                      Space add
                    </span>
                    {" · "}
                    <span className="lc-tip-target" data-tip="Reset session" data-tip-placement="top">
                      X reset
                    </span>
                    {" · "}
                    <span
                      className="lc-tip-target"
                      data-tip="Open the highlighted problem"
                      data-tip-placement="top"
                    >
                      Enter open
                    </span>
                  </span>
                  <span className="lc-browser-foot-stats lc-muted">
                    {picked.size > 0
                      ? `${picked.size} selected`
                      : session && session.queue.length > 0
                        ? `${session.queue.length} in queue · ${session.stats?.passed ?? 0} passed · ${session.stats?.failed ?? 0} failed`
                        : "no session queue"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <BackgroundPalette themeId={themeId} onPick={onThemePick} variant="inline" />
    </section>
  );
}


/**
 * The problem-set tab strip.
 *
 * Every dataset is shown even when its corpus has not been downloaded, with a
 * count of 0 — a missing tab would read as "lc doesn't support that one", which
 * is the opposite of what an empty one says.
 */
function DatasetTabs({
  datasets,
  active,
  disabled,
  onPick,
}: {
  datasets: DatasetInfo[];
  active: string;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  // An older daemon returns nothing; one tab is the honest rendering of that.
  if (datasets.length <= 1) return null;
  return (
    <div className="lc-dataset-tabs" role="tablist" aria-label="Problem set">
      {datasets.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={entry.id === active}
          className={[
            "lc-dataset-tab",
            "lc-tip-target",
            entry.id === active ? "is-active" : "",
            entry.count === 0 ? "is-empty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={disabled}
          data-tip={`${entry.source} — ${entry.count.toLocaleString()} indexed`}
          data-tip-placement="bottom"
          onClick={() => onPick(entry.id)}
        >
          {entry.label}
          <span className="lc-dataset-tab-count">{entry.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

/** Why the table is empty: no matches, or nothing indexed for this tab yet. */
function EmptyTable({ dataset, datasets }: { dataset: string; datasets: DatasetInfo[] }) {
  const info = datasets.find((entry) => entry.id === dataset);
  if (info && info.count === 0) {
    return (
      <p className="lc-muted lc-table-empty">
        Nothing indexed for <strong>{info.label}</strong> yet. Download{" "}
        <code>{info.source}</code>
        {info.corpus_dir ? (
          <>
            {" "}
            into <code>{info.corpus_dir}</code>
          </>
        ) : null}
        , then run <code>lc index --dataset {info.id}</code>.
      </p>
    );
  }
  return (
    <p className="lc-muted lc-table-empty">
      No matches. If the corpus changed, run <code>lc index</code>.
    </p>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
