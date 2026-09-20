/**
 * Live LeetCode canvas working copy. Hub `pads.db` is the LAN copy.
 * Attempt history stays on the PC under `.lc/attempts/`.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, withStore, STORE_PROBLEM_BOARDS } from "./idb";
import { artifactCatalogFields, type ArtifactCatalog } from "./padArtifacts";

export function problemPadId(dataset: string, taskId: string): string {
  return `${dataset.trim()}/${taskId.trim()}`;
}

export interface ProblemBoardRecord {
  artifacts?: ArtifactCatalog;
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
  return row ? { ...row, ...artifactCatalogFields(row.artifacts, { kind: "problem", id }) } : null;
}

export async function putProblemBoard(row: ProblemBoardRecord): Promise<void> {
  const supplied = artifactCatalogFields(row.artifacts, { kind: "problem", id: row.id });
  // One transaction: another window cannot insert a catalog between our read
  // and an ink/chat-only write. Never interpret an omitted field as deletion.
  let invalidCatalog: unknown;
  try {
    await withStore(STORE_PROBLEM_BOARDS, "readwrite", (store) => {
      const request = store.get(row.id);
      request.onsuccess = () => {
        try {
          const fields = row.artifacts === undefined
            ? artifactCatalogFields((request.result as ProblemBoardRecord | undefined)?.artifacts,
              { kind: "problem", id: row.id })
            : supplied;
          store.put({ ...row, ...fields }, row.id);
        } catch (cause) {
          invalidCatalog = cause;
          store.transaction.abort();
        }
      };
    });
  } catch (cause) {
    throw invalidCatalog ?? cause;
  }
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
