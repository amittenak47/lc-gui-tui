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
import { useIsMobile } from "../util/mobile";
import {
  loadOfflinePack,
  offlineListDatasets,
  offlineListTags,
  offlineSearch,
  type OfflinePack,
} from "../util/offlineCorpus";
import { titleFromSlug } from "../util/text";
import { loadBrowsePosition, saveBrowsePosition } from "../util/browsePosition";

export const PAGE_SIZE = 15;
/** Smallest page the phone browser will request — still usable on iPhone SE. */
const MOBILE_PAGE_SIZE_MIN = 6;

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
  /** When lc serve is unreachable — skip fetches and show a calm empty state. */
  offline?: boolean;
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
  offline = false,
  onStartSession,
  onResetSession,
  onRandomSession,
}: ProblemBrowserProps) {
  const mobile = useIsMobile();
  const initial = useMemo(() => loadBrowsePosition(), []);
  const [dataset, setDataset] = useState<string>(initial.dataset);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [query, setQuery] = useState(initial.query);
  const [difficulty, setDifficulty] = useState<string>(initial.difficulty);
  const [tag, setTag] = useState<string>(initial.tag);
  const [sort, setSort] = useState<string>(initial.sort);
  const [page, setPage] = useState(initial.page);

  const [rows, setRows] = useState<ProblemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(initial.selected);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** False until the first search returns — avoids filters-then-table flash. */
  const [tableReady, setTableReady] = useState(false);
  const tableReadyRef = useRef(false);
  /** Multi-select mode: clicks toggle picks instead of opening. */
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [offlinePack, setOfflinePack] = useState<OfflinePack | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  // On phone, size the page to the rows that fit under the filters — no table scroll.
  useEffect(() => {
    if (!mobile || !tableReady) {
      if (!mobile) setPageSize(PAGE_SIZE);
      return;
    }
    const measure = () => {
      const body = bodyRef.current;
      if (!body) return;
      const viewportH = window.innerHeight;
      const top = body.getBoundingClientRect().top;
      const palette = body
        .closest(".lc-browser")
        ?.querySelector(".lc-bg-palette-inline");
      const paletteH = palette?.getBoundingClientRect().height ?? 28;
      const foot = body.querySelector(".lc-browser-foot");
      const footH = foot?.getBoundingClientRect().height ?? 64;
      const filters = body.querySelector(".lc-browser-filters");
      const tabs = body.querySelector(".lc-dataset-tabs");
      const head = body.querySelector(".lc-table-head");
      const filtersH = filters?.getBoundingClientRect().height ?? 26;
      const tabsH = tabs?.getBoundingClientRect().height ?? 0;
      const headH = head?.getBoundingClientRect().height ?? 20;
      const gaps = 24;
      const tableChrome = 12;
      const avail = viewportH - top - paletteH - footH - gaps;
      const rowSlot = 30;
      const count = Math.floor((avail - filtersH - tabsH - headH - tableChrome) / rowSlot);
      setPageSize(Math.max(MOBILE_PAGE_SIZE_MIN, Math.min(PAGE_SIZE, count)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (bodyRef.current) ro.observe(bodyRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mobile, tableReady]);

  useEffect(() => setPage(0), [pageSize]);

  useEffect(() => {
    if (!offline) {
      setOfflinePack(null);
      return;
    }
    let cancelled = false;
    void loadOfflinePack().then((pack) => {
      if (cancelled) return;
      setOfflinePack(pack);
      if (pack) {
        const list = offlineListDatasets(pack);
        setDatasets(list);
        setDataset((current) =>
          list.some((entry) => entry.id === current) ? current : list[0]?.id ?? current,
        );
      } else {
        setDatasets([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [offline]);

  useEffect(() => {
    let cancelled = false;
    if (offline) {
      if (offlinePack) {
        setTags(offlineListTags(offlinePack, dataset));
      } else {
        setTags([]);
      }
      return;
    }
    void client
      .tags(dataset)
      .then((all) => !cancelled && setTags(all))
      .catch(() => {
        /* The filter is optional; a failure here shouldn't block browsing. */
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataset, offline, offlinePack]);

  useEffect(() => {
    if (offline) return;
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
  }, [client, offline]);

  // Any filter change resets to the first page — as in the TUI.
  // Skip the first run so a restored browse position keeps its page.
  const skipPageResetRef = useRef(true);
  useEffect(() => {
    if (skipPageResetRef.current) {
      skipPageResetRef.current = false;
      return;
    }
    setPage(0);
  }, [query, difficulty, tag, sort, dataset]);

  // Persist browse spot so returning from a problem lands on the same tab/page.
  useEffect(() => {
    saveBrowsePosition({
      dataset,
      query,
      difficulty,
      tag,
      sort,
      page,
      selected,
    });
  }, [dataset, query, difficulty, tag, sort, page, selected]);
  useEffect(() => {
    if (offline) {
      setLoading(false);
      if (!offlinePack) {
        setRows([]);
        setTotal(0);
        setError(null);
        tableReadyRef.current = true;
        setTableReady(true);
        return;
      }
      const result = offlineSearch(offlinePack, {
        dataset,
        q: query || undefined,
        difficulty: difficulty || undefined,
        tag: tag || undefined,
        sort,
        limit: pageSize,
        offset: page * pageSize,
      });
      setRows(result.items);
      setTotal(result.total);
      setSelected((current) => Math.min(current, Math.max(result.items.length - 1, 0)));
      setError(null);
      tableReadyRef.current = true;
      setTableReady(true);
      return;
    }
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
          limit: pageSize,
          offset: page * pageSize,
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
  }, [client, dataset, query, difficulty, tag, sort, page, pageSize, offline, offlinePack]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

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
      // A modal owns the keyboard while it is up — otherwise holding Space on
      // "Reset session" also adds the highlighted row to the picks.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
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

  // Keep the highlighted row visible when moving with the keyboard (desktop only).
  useEffect(() => {
    if (mobile) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, mobile]);

  const rangeLabel = useMemo(() => {
    if (total === 0) return "no matches";
    const first = page * pageSize + 1;
    const last = Math.min(total, (page + 1) * pageSize);
    return `${first}–${last} of ${total}`;
  }, [page, total, pageSize]);

  return (
    <section className="lc-browser" aria-label="Browse problems">
      <div className="lc-browser-center">
        {!tableReady ? (
          <div className="lc-browser-loading" role="status" aria-live="polite" aria-label="Loading problems">
            <div className="lc-spinner" aria-hidden="true" />
          </div>
        ) : (
          <div className="lc-browser-body lc-browser-body-ready" ref={bodyRef}>
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
                value={query}
                placeholder={mobile ? "/ search" : "/  name, question number, or tag"}
                aria-label="Search problems"
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="lc-filter-diff"
                value={difficulty}
                aria-label="Difficulty"
                onChange={(event) => setDifficulty(event.target.value)}
              >
                {DIFFICULTIES.map((value) => (
                  <option key={value || "any"} value={value}>
                    {value || (mobile ? "diff" : "difficulty")}
                  </option>
                ))}
              </select>
              <select
                className="lc-filter-tag"
                value={tag}
                aria-label="Tag"
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">tag</option>
                {tags.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                className="lc-filter-sort"
                value={sort}
                aria-label="Sort"
                onChange={(event) => setSort(event.target.value)}
              >
                {SORTS.map((value) => (
                  <option key={value} value={value}>
                    {SORT_LABEL[value]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="lc-secondary"
                disabled={busy || !onRandomSession}
                onClick={randomizeSession}
              >
                Random
              </button>
            </div>

            {error && <p className="lc-warning">{error}</p>}
            {offline && (
              <p className="lc-muted">
                {offlinePack
                  ? `Offline pack · ${offlinePack.problems.length.toLocaleString()} problems (no KodCode).`
                  : "Offline — download a problem pack while online (Settings → Server), or open a scratchpad."}
              </p>
            )}

            <div className={loading ? "lc-browser-results lc-browser-results-pending" : "lc-browser-results"}>
              <div className="lc-table-head" aria-hidden="true">
                <span className="lc-col-q">q#</span>
                <span className="lc-col-name">name</span>
                <span className="lc-col-diff">difficulty</span>
                <span className="lc-col-tags">tags</span>
                <span className="lc-col-cases">cases</span>
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
                        {titleFromSlug(problem.task_id, problem.question_id)}
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
                  <div className="lc-browser-foot-actions">
                    <button
                      type="button"
                      className="lc-secondary"
                      disabled={busy || !onStartSession}
                      onClick={commitStart}
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      className="lc-secondary"
                      disabled={busy || !onResetSession}
                      onClick={commitReset}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      className={selectMode ? "lc-secondary is-active" : "lc-secondary"}
                      disabled={busy}
                      aria-pressed={selectMode}
                      onClick={() => setSelectMode((on) => !on)}
                    >
                      Select{picked.size > 0 ? ` (${picked.size})` : ""}
                    </button>
                  </div>
                  <div className="lc-browser-foot-nav">
                    <button
                      type="button"
                      className="lc-secondary"
                      disabled={page === 0 || loading}
                      onClick={() => turnPage(-1)}
                    >
                      <span className="lc-label-long">‹ prev</span>
                      <span className="lc-label-short">‹</span>
                    </button>
                    <span className="lc-muted lc-browser-page-label">
                      <span className="lc-browser-page-range">{rangeLabel}</span>
                      <span className="lc-browser-page-pages">
                        page {page + 1}/{pageCount}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="lc-secondary"
                      disabled={page >= pageCount - 1 || loading}
                      onClick={() => turnPage(1)}
                    >
                      <span className="lc-label-long">next ›</span>
                      <span className="lc-label-short">›</span>
                    </button>
                  </div>
                </div>
                <div className="lc-browser-foot-keys">
                  <span className="lc-keys lc-muted lc-desktop-only">
                    W/S move · A/D page · / search · T tag · E diff · O sort · G dataset · R
                    random · M select · Space add · X reset · Enter open
                  </span>
                  <span className="lc-browser-foot-stats lc-muted">
                    {picked.size > 0
                      ? `${picked.size} selected`
                      : session && session.queue.length > 0
                        ? `${session.queue.length} in queue · ${session.stats?.passed ?? 0} passed · ${session.stats?.failed ?? 0} failed`
                        : "no session queue"}
                  </span>
                  <BackgroundPalette
                    themeId={themeId}
                    onPick={onThemePick}
                    variant="map"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
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
            entry.id === active ? "is-active" : "",
            entry.count === 0 ? "is-empty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={disabled}
          title={entry.source}
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
