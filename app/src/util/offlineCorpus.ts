/**
 * Device-local offline problem pack (all datasets except KodCode).
 *
 * Downloaded from `GET /offline/pack` while online, stored in IndexedDB, and
 * used by the browser / pickProblem when `lc serve` is unreachable.
 */

import type { DatasetInfo, ProblemDetail, ProblemPage, ProblemSummary } from "../api/types";

const DB_NAME = "lc.offline.corpus.v1";
/** v2: same store; download checkpoints live under key `download`. */
const DB_VERSION = 2;
const STORE = "pack";
const PACK_KEY = "current";

export interface OfflinePack {
  v: number;
  built_at: number;
  datasets: DatasetInfo[];
  problems: ProblemDetail[];
  tags: Record<string, string[]>;
  /** Per-dataset index watermark — enables delta refresh. */
  dataset_built_at?: Record<string, number>;
}

export interface OfflinePackMeta {
  built_at: number;
  problemCount: number;
  datasets: DatasetInfo[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

export async function saveOfflinePack(pack: OfflinePack): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).put(pack, PACK_KEY));
  } finally {
    db.close();
  }
}

export async function loadOfflinePack(): Promise<OfflinePack | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const raw = await idbReq(tx.objectStore(STORE).get(PACK_KEY));
    if (!raw || typeof raw !== "object") return null;
    const pack = raw as OfflinePack;
    if (pack.v !== 1 || !Array.isArray(pack.problems) || !Array.isArray(pack.datasets)) {
      return null;
    }
    return pack;
  } finally {
    db.close();
  }
}

export async function clearOfflinePack(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).delete(PACK_KEY));
  } finally {
    db.close();
  }
}

export async function offlinePackMeta(): Promise<OfflinePackMeta | null> {
  const pack = await loadOfflinePack();
  if (!pack) return null;
  return {
    built_at: pack.built_at,
    problemCount: pack.problems.length,
    datasets: pack.datasets,
  };
}

export function offlineListDatasets(pack: OfflinePack): DatasetInfo[] {
  return pack.datasets.filter((entry) => entry.id !== "kodcode");
}

export function offlineListTags(pack: OfflinePack, dataset: string): string[] {
  return pack.tags[dataset] ?? [];
}

export function offlineSearch(
  pack: OfflinePack,
  opts: {
    dataset: string;
    q?: string;
    difficulty?: string;
    tag?: string;
    sort?: string;
    limit: number;
    offset: number;
  },
): ProblemPage {
  const needle = (opts.q ?? "").trim().toLowerCase();
  let items = pack.problems.filter((problem) => problem.dataset === opts.dataset);

  if (opts.difficulty) {
    items = items.filter((problem) => problem.difficulty === opts.difficulty);
  }
  if (opts.tag) {
    items = items.filter((problem) => problem.tags.includes(opts.tag!));
  }
  if (needle) {
    items = items.filter((problem) => {
      const hay = `${problem.task_id} ${problem.question_id ?? ""} ${problem.tags.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  const sort = opts.sort ?? "task_id";
  items = [...items].sort((a, b) => {
    switch (sort) {
      case "question":
        return String(a.question_id ?? "").localeCompare(String(b.question_id ?? ""), undefined, {
          numeric: true,
        });
      case "difficulty":
        return String(a.difficulty ?? "").localeCompare(String(b.difficulty ?? ""));
      case "cases":
        return a.cases.length - b.cases.length;
      case "tags":
        return a.tags.join(",").localeCompare(b.tags.join(","));
      default:
        return a.task_id.localeCompare(b.task_id);
    }
  });

  const total = items.length;
  const slice = items.slice(opts.offset, opts.offset + opts.limit);
  const summaries: ProblemSummary[] = slice.map((problem) => ({
    dataset: problem.dataset,
    task_id: problem.task_id,
    key: problem.key,
    question_id: problem.question_id,
    difficulty: problem.difficulty,
    tags: problem.tags,
    test_count: problem.cases.length,
  }));

  return {
    items: summaries,
    total,
    offset: opts.offset,
    limit: opts.limit,
  };
}

export function offlineGetProblem(
  pack: OfflinePack,
  taskId: string,
  dataset: string,
): ProblemDetail | null {
  return (
    pack.problems.find(
      (problem) => problem.task_id === taskId && problem.dataset === dataset,
    ) ?? null
  );
}

export function offlineAdjacent(
  pack: OfflinePack,
  taskId: string,
  opts: {
    dataset: string;
    q?: string;
    difficulty?: string;
    tag?: string;
    sort?: string;
  },
): { prev: string | null; next: string | null } {
  const page = offlineSearch(pack, {
    ...opts,
    limit: 100_000,
    offset: 0,
  });
  const index = page.items.findIndex((item) => item.task_id === taskId);
  if (index < 0) return { prev: null, next: null };
  return {
    prev: index > 0 ? page.items[index - 1].task_id : null,
    next: index < page.items.length - 1 ? page.items[index + 1].task_id : null,
  };
}

export function offlineRandom(
  pack: OfflinePack,
  opts: {
    dataset: string;
    q?: string;
    difficulty?: string;
    tag?: string;
  },
): ProblemSummary | null {
  const page = offlineSearch(pack, { ...opts, sort: "task_id", limit: 100_000, offset: 0 });
  if (page.items.length === 0) return null;
  return page.items[Math.floor(Math.random() * page.items.length)] ?? null;
}
