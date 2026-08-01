/**
 * Resumable offline pack download — chunked checkpoints, delta refresh,
 * background download, pause on app background, resume on foreground.
 */

import type { LcClient } from "../api/client";
import type { DatasetInfo, ProblemDetail } from "../api/types";
import type { OfflinePack } from "./offlineCorpus";
import { loadOfflinePack, saveOfflinePack } from "./offlineCorpus";

const DB_NAME = "lc.offline.corpus.v1";
const DB_VERSION = 2;
const STORE = "pack";
const DOWNLOAD_KEY = "download";

export interface OfflinePackManifest {
  v: number;
  built_at: number;
  chunk_size: number;
  total_problems: number;
  datasets: Array<{
    id: string;
    label: string;
    problem_count: number;
    built_at: number;
    tags: string[];
  }>;
}

export interface OfflinePackChunk {
  dataset: string;
  offset: number;
  problems: ProblemDetail[];
}

export interface OfflineDatasetKeys {
  dataset: string;
  offset: number;
  task_ids: string[];
}

type DownloadMode = "full" | "delta";

/** In-progress download persisted between sessions. */
export interface OfflineDownloadCheckpoint {
  v: 2;
  mode: DownloadMode;
  /** Target manifest fingerprint. */
  built_at: number;
  chunk_size: number;
  total_work: number;
  work_done: number;
  datasets: DatasetInfo[];
  tags: Record<string, string[]>;
  dataset_built_at: Record<string, number>;
  /** Merged problems accumulated this run. */
  problems: ProblemDetail[];
  /** Datasets still to process (ids). */
  pending_datasets: string[];
  dataset_id: string;
  offset: number;
  /** `fetch` problems, then `reconcile` task ids. */
  step: "fetch" | "reconcile";
  delta_since: number;
  reconcile_ids: string[];
  /** Snapshot of per-dataset watermarks at run start (delta mode). */
  source_built_at: Record<string, number>;
  stale_count: number;
}

export type OfflineDownloadPhase = "idle" | "running" | "paused" | "done" | "error";

export interface OfflineDownloadSnapshot {
  phase: OfflineDownloadPhase;
  progress: number;
  indeterminate: boolean;
  received: number;
  total: number;
  error: string | null;
  info: string | null;
  resumable: boolean;
  mode: DownloadMode | null;
}

type Listener = (snap: OfflineDownloadSnapshot) => void;

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

async function loadCheckpoint(): Promise<OfflineDownloadCheckpoint | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const raw = await idbReq(tx.objectStore(STORE).get(DOWNLOAD_KEY));
    if (!raw || typeof raw !== "object") return null;
    const cp = raw as OfflineDownloadCheckpoint;
    if (cp.v !== 2 || !Array.isArray(cp.problems) || !Array.isArray(cp.pending_datasets)) {
      return null;
    }
    return cp;
  } finally {
    db.close();
  }
}

async function saveCheckpoint(cp: OfflineDownloadCheckpoint): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).put(cp, DOWNLOAD_KEY));
  } finally {
    db.close();
  }
}

async function clearCheckpoint(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).delete(DOWNLOAD_KEY));
  } finally {
    db.close();
  }
}

function datasetBuiltAt(pack: OfflinePack | null, datasetId: string): number {
  if (!pack) return 0;
  return pack.dataset_built_at?.[datasetId] ?? pack.built_at ?? 0;
}

function staleDatasets(
  manifest: OfflinePackManifest,
  pack: OfflinePack | null,
): OfflinePackManifest["datasets"] {
  if (!pack) return manifest.datasets;
  return manifest.datasets.filter((plan) => datasetBuiltAt(pack, plan.id) < plan.built_at);
}

function mergeProblemsByKey(problems: ProblemDetail[]): ProblemDetail[] {
  const map = new Map<string, ProblemDetail>();
  for (const problem of problems) map.set(problem.key, problem);
  return [...map.values()];
}

function reconcileDataset(
  problems: ProblemDetail[],
  datasetId: string,
  taskIds: Set<string>,
): ProblemDetail[] {
  return problems.filter(
    (problem) => problem.dataset !== datasetId || taskIds.has(problem.task_id),
  );
}

class OfflinePackDownloader {
  private phase: OfflineDownloadPhase = "idle";
  private progress = 0;
  private indeterminate = false;
  private received = 0;
  private total = 0;
  private error: string | null = null;
  private info: string | null = null;
  private resumable = false;
  private mode: DownloadMode | null = null;
  private pauseAfterChunk = false;
  private running = false;
  private pausedByBackground = false;
  private client: LcClient | null = null;
  private listeners = new Set<Listener>();

  bindClient(client: LcClient): void {
    this.client = client;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): OfflineDownloadSnapshot {
    return {
      phase: this.phase,
      progress: this.progress,
      indeterminate: this.indeterminate,
      received: this.received,
      total: this.total,
      error: this.error,
      info: this.info,
      resumable: this.resumable,
      mode: this.mode,
    };
  }

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private setProgress(workDone: number, totalWork: number) {
    this.received = workDone;
    this.total = totalWork;
    this.progress = totalWork > 0 ? Math.min(0.99, workDone / totalWork) : 0;
    this.indeterminate = totalWork <= 0;
  }

  async hydrate(): Promise<void> {
    const cp = await loadCheckpoint();
    if (!cp) {
      this.resumable = false;
      this.phase = "idle";
      this.emit();
      return;
    }
    this.resumable = true;
    this.mode = cp.mode;
    this.setProgress(cp.work_done, cp.total_work);
    this.phase = "paused";
    this.emit();
  }

  /** Pause after the current chunk is checkpointed. */
  pause(): void {
    if (this.phase === "running") this.pauseAfterChunk = true;
  }

  /** Hold-to-abort — clears checkpoint; finished pack on device stays. */
  async abort(): Promise<void> {
    this.pauseAfterChunk = false;
    this.pausedByBackground = false;
    await clearCheckpoint();
    this.phase = "idle";
    this.progress = 0;
    this.indeterminate = false;
    this.received = 0;
    this.total = 0;
    this.error = null;
    this.info = null;
    this.resumable = false;
    this.mode = null;
    this.emit();
  }

  onBackground(): void {
    if (this.phase === "running") {
      this.pausedByBackground = true;
      this.pause();
    }
  }

  onForeground(): void {
    if (
      this.pausedByBackground &&
      this.client &&
      (this.phase === "paused" || this.resumable)
    ) {
      this.pausedByBackground = false;
      void this.start(this.client);
    }
  }

  async start(
    client: LcClient,
    opts?: { force?: boolean; delta?: boolean },
  ): Promise<void> {
    if (this.running) return;
    this.client = client;
    this.running = true;
    this.pauseAfterChunk = false;
    this.error = null;
    this.info = null;
    this.phase = "running";
    this.indeterminate = true;
    this.emit();

    try {
      const manifest = await client.offlinePackManifest();
      const existing = await loadOfflinePack();
      let cp = opts?.force ? null : await loadCheckpoint();

      if (cp && cp.built_at !== manifest.built_at) {
        cp = null;
        await clearCheckpoint();
      }

      const wantDelta = opts?.delta ?? Boolean(existing && !opts?.force);
      const stale = staleDatasets(manifest, existing);

      if (!cp && wantDelta && existing && stale.length === 0) {
        this.phase = "idle";
        this.info = "Already up to date — no indexed changes since last download.";
        this.progress = 1;
        this.indeterminate = false;
        this.resumable = false;
        this.mode = "delta";
        this.emit();
        return;
      }

      if (!cp) {
        const mode: DownloadMode = wantDelta && existing ? "delta" : "full";
        const targets =
          mode === "delta" && existing ? stale : manifest.datasets;
        const allDatasets = await client.datasets();
        const datasets: DatasetInfo[] = allDatasets
          .filter((d) => d.id !== "kodcode")
          .map((d) => {
            const plan = manifest.datasets.find((p) => p.id === d.id);
            return plan ? { ...d, count: plan.problem_count } : d;
          });
        const tags: Record<string, string[]> = {};
        for (const d of manifest.datasets) tags[d.id] = d.tags;

        const dataset_built_at: Record<string, number> = {};
        for (const plan of manifest.datasets) {
          dataset_built_at[plan.id] = plan.built_at;
        }

        const source_built_at: Record<string, number> = {};
        for (const plan of manifest.datasets) {
          source_built_at[plan.id] = datasetBuiltAt(existing, plan.id);
        }

        let baseProblems: ProblemDetail[] = [];
        if (mode === "delta" && existing) {
          const staleIds = new Set(targets.map((t) => t.id));
          baseProblems = existing.problems.filter((p) => !staleIds.has(p.dataset));
          for (const plan of targets) {
            for (const p of existing.problems) {
              if (p.dataset === plan.id) baseProblems.push(p);
            }
          }
        }

        const totalWork =
          mode === "delta" ? Math.max(1, targets.length) : manifest.total_problems;
        const first = targets[0];

        cp = {
          v: 2,
          mode,
          built_at: manifest.built_at,
          chunk_size: manifest.chunk_size,
          total_work: totalWork,
          work_done: 0,
          datasets,
          tags,
          dataset_built_at,
          problems: baseProblems,
          pending_datasets: targets.map((t) => t.id),
          dataset_id: first?.id ?? "",
          offset: 0,
          step: "fetch",
          delta_since: 0,
          reconcile_ids: [],
          source_built_at,
          stale_count: targets.length,
        };

        if (first) {
          cp.delta_since = mode === "delta" ? source_built_at[first.id] ?? 0 : 0;
        }
      }

      this.mode = cp.mode;
      this.setProgress(cp.work_done, cp.total_work);
      this.resumable = true;
      this.emit();

      if (manifest.datasets.length === 0) {
        await this.finish(cp, manifest.built_at);
        return;
      }

      while (cp.pending_datasets.length > 0) {
        if (this.pauseAfterChunk) {
          await saveCheckpoint(cp);
          this.phase = "paused";
          this.resumable = true;
          this.indeterminate = false;
          this.emit();
          return;
        }

        const datasetId = cp.pending_datasets[0]!;
        const plan = manifest.datasets.find((d) => d.id === datasetId);
        if (!plan) {
          cp.pending_datasets.shift();
          continue;
        }
        cp.dataset_id = datasetId;

        if (cp.step === "fetch") {
          const since =
            cp.mode === "delta" && cp.delta_since > 0 ? cp.delta_since : undefined;
          const chunk = await client.offlinePackChunk({
            dataset: datasetId,
            offset: cp.offset,
            limit: manifest.chunk_size,
            since,
          });

          if (chunk.problems.length === 0) {
            cp.step = "reconcile";
            cp.offset = 0;
            cp.reconcile_ids = [];
            await saveCheckpoint(cp);
            continue;
          }

          cp.problems.push(...chunk.problems);
          cp.offset += chunk.problems.length;
          if (cp.mode === "full") {
            cp.work_done = cp.problems.length;
          } else {
            const done = cp.stale_count - cp.pending_datasets.length;
            cp.work_done = done;
          }
          this.setProgress(cp.work_done, cp.total_work);
          await saveCheckpoint(cp);
          this.emit();

          const pageFull = chunk.problems.length < manifest.chunk_size;
          const datasetDone =
            cp.mode === "full" &&
            (cp.offset >= plan.problem_count || pageFull);
          const deltaPageDone = cp.mode === "delta" && pageFull;

          if (datasetDone || deltaPageDone) {
            cp.step = "reconcile";
            cp.offset = 0;
            cp.reconcile_ids = [];
          }
          continue;
        }

        // reconcile — trim deletions after index changes.
        const keysPage = await client.offlinePackDatasetKeys({
          dataset: datasetId,
          offset: cp.offset,
          limit: manifest.chunk_size * 4,
        });

        if (keysPage.task_ids.length === 0 && cp.offset === 0) {
          cp.pending_datasets.shift();
          cp.step = "fetch";
          cp.offset = 0;
          cp.reconcile_ids = [];
          if (cp.pending_datasets[0]) {
            const nextId = cp.pending_datasets[0];
            cp.dataset_id = nextId;
            cp.delta_since =
              cp.mode === "delta" ? cp.source_built_at[nextId] ?? 0 : 0;
          }
          await saveCheckpoint(cp);
          continue;
        }

        cp.reconcile_ids.push(...keysPage.task_ids);
        cp.offset += keysPage.task_ids.length;

        if (keysPage.task_ids.length < manifest.chunk_size * 4) {
          const idSet = new Set(cp.reconcile_ids);
          cp.problems = reconcileDataset(cp.problems, datasetId, idSet);
          cp.problems = mergeProblemsByKey(cp.problems);
          cp.dataset_built_at[datasetId] = plan.built_at;
          cp.tags[datasetId] = plan.tags;
          if (cp.mode === "delta") {
            cp.work_done = cp.stale_count - cp.pending_datasets.length;
          }
          cp.pending_datasets.shift();
          cp.step = "fetch";
          cp.offset = 0;
          cp.reconcile_ids = [];
          if (cp.pending_datasets[0]) {
            const nextId = cp.pending_datasets[0];
            cp.dataset_id = nextId;
            cp.delta_since =
              cp.mode === "delta" ? cp.source_built_at[nextId] ?? 0 : 0;
          }
          this.setProgress(cp.work_done, cp.total_work);
        }

        await saveCheckpoint(cp);
        this.emit();
      }

      await this.finish(cp, manifest.built_at);
    } catch (cause) {
      this.phase = "error";
      this.error = cause instanceof Error ? cause.message : "Offline pack download failed";
      this.indeterminate = false;
      this.resumable = true;
      this.emit();
    } finally {
      this.running = false;
      this.pauseAfterChunk = false;
    }
  }

  private async finish(cp: OfflineDownloadCheckpoint, builtAt: number): Promise<void> {
    const pack: OfflinePack = {
      v: 1,
      built_at: builtAt,
      datasets: cp.datasets,
      problems: mergeProblemsByKey(cp.problems),
      tags: cp.tags,
      dataset_built_at: cp.dataset_built_at,
    };
    await saveOfflinePack(pack);
    await clearCheckpoint();
    this.phase = "done";
    this.progress = 1;
    this.indeterminate = false;
    this.resumable = false;
    this.received = pack.problems.length;
    this.total = pack.problems.length;
    this.emit();
  }
}

export const offlinePackDownloader = new OfflinePackDownloader();
