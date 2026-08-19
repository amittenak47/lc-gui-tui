/**
 * Live LeetCode canvas working copy. Hub `pads.db` is the LAN copy.
 * Attempt history stays on the PC under `.lc/attempts/`.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, STORE_PROBLEM_BOARDS } from "./idb";

export function problemPadId(dataset: string, taskId: string): string {
  return `${dataset.trim()}/${taskId.trim()}`;
}

export interface ProblemBoardRecord {
  id: string;
  dataset: string;
  taskId: string;
  updatedAt: number;
  syncSeq?: number;
  hubAckUpdatedAt?: number;
  board: BoardBlob;
  agent?: unknown[];
}

export async function getProblemBoard(id: string): Promise<ProblemBoardRecord | null> {
  const row = await run<ProblemBoardRecord | undefined>(
    STORE_PROBLEM_BOARDS,
    "readonly",
    (store) => store.get(id),
  );
  return row ?? null;
}

export async function putProblemBoard(row: ProblemBoardRecord): Promise<void> {
  await run(STORE_PROBLEM_BOARDS, "readwrite", (store) => store.put(row, row.id));
}

export async function deleteProblemBoard(id: string): Promise<void> {
  await run(STORE_PROBLEM_BOARDS, "readwrite", (store) => store.delete(id));
}

export function markProblemHubAck(id: string, updatedAt: number): void {
  void getProblemBoard(id).then((row) => {
    if (!row) return;
    void putProblemBoard({ ...row, hubAckUpdatedAt: updatedAt });
  });
}
