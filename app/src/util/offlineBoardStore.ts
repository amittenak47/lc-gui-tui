/**
 * Offline coding-problem boards. Pads use tombstone + revision instead.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, STORE_OFFLINE_BOARDS } from "./idb";
import type { OfflineMergePolicy } from "./offlineMerge";

export interface OfflineBoardRecord {
  dataset: string;
  taskId: string;
  board: BoardBlob;
  updatedAt: number;
}

function recordId(dataset: string, taskId: string): string {
  return `${dataset}\u001f${taskId}`;
}

export async function putOfflineBoard(row: OfflineBoardRecord): Promise<void> {
  await run(STORE_OFFLINE_BOARDS, "readwrite", (store) => store.put(row, recordId(row.dataset, row.taskId)));
}

export async function getOfflineBoard(
  dataset: string,
  taskId: string,
): Promise<OfflineBoardRecord | null> {
  const row = await run<OfflineBoardRecord | undefined>(
    STORE_OFFLINE_BOARDS,
    "readonly",
    (store) => store.get(recordId(dataset, taskId)),
  );
  return row ?? null;
}

export async function deleteOfflineBoard(dataset: string, taskId: string): Promise<void> {
  await run(STORE_OFFLINE_BOARDS, "readwrite", (store) => store.delete(recordId(dataset, taskId)));
}

export async function listOfflineBoards(): Promise<OfflineBoardRecord[]> {
  const db = await import("./idb").then((mod) => mod.openDb());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OFFLINE_BOARDS, "readonly");
    const req = tx.objectStore(STORE_OFFLINE_BOARDS).getAll();
    req.onsuccess = () => resolve((req.result as OfflineBoardRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("could not list offline boards"));
  });
}

export type OfflineMergeChoice = "local" | "server" | "ask";

/** Pick a side from two timestamps. `ask` stays `ask` when they differ. */
export function chooseOfflineMerge(
  policy: OfflineMergePolicy,
  localUpdatedAt: number,
  serverUpdatedAt: number | null,
): OfflineMergeChoice {
  if (serverUpdatedAt == null) return "local";
  if (localUpdatedAt === serverUpdatedAt) return "local";
  if (policy === "prefer-local") return "local";
  if (policy === "prefer-server") return "server";
  return "ask";
}
