/**
 * Live LeetCode canvas working copy. Hub `pads.db` is the LAN copy.
 * Attempt history stays on the PC under `.lc/attempts/`.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, withStore, STORE_PROBLEM_BOARDS } from "./idb";
import { artifactCatalogFields, type ArtifactCatalog } from "./padArtifacts";
import { ArtifactEditConflict, editArtifactCatalog, requireArtifactCatalogTransition, type ArtifactCatalogEdit } from "./artifactCatalogEdits";
import { downloadArtifactAssets } from "./artifactAssetSync";

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
          const artifacts = requireArtifactCatalogTransition(
            (request.result as ProblemBoardRecord | undefined)?.artifacts,
            supplied.artifacts, { kind: "problem", id: row.id });
          const fields = artifacts ? { artifacts } : {};
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
  // An acknowledgement must not write an old board/catalog read before a save.
  void withStore(STORE_PROBLEM_BOARDS, "readwrite", (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const row = request.result as ProblemBoardRecord | undefined;
      if (row) store.put({ ...row, hubAckUpdatedAt: Math.max(row.hubAckUpdatedAt ?? 0, updatedAt) }, id);
    };
  }).catch(() => {});
}

/** Dependencies first, then CAS the catalog while preserving the latest board/chat. */
export async function editProblemArtifacts(
  id: string, expectedCatalogRevision: string | null, edit: ArtifactCatalogEdit,
): Promise<ArtifactCatalog> {
  const initial = await getProblemBoard(id);
  if (!initial) throw new Error("Save the problem board before attaching content.");
  const next = editArtifactCatalog(initial.artifacts, { kind: "problem", id }, expectedCatalogRevision, edit);
  // No network: every required immutable revision must already be staged locally.
  await downloadArtifactAssets(undefined, next);
  let failure: unknown;
  try {
    await withStore(STORE_PROBLEM_BOARDS, "readwrite", (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          const current = request.result as ProblemBoardRecord | undefined;
          const catalog = artifactCatalogFields(current?.artifacts, { kind: "problem", id }).artifacts;
          if (!current || (catalog?.revision ?? null) !== expectedCatalogRevision) throw new ArtifactEditConflict();
          const artifacts = requireArtifactCatalogTransition(catalog, next, { kind: "problem", id })!;
          if (catalog?.revision === artifacts.revision) return;
          store.put({ ...current, artifacts, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }, id);
        } catch (cause) { failure = cause; store.transaction.abort(); }
      };
    });
  } catch (cause) { throw failure ?? cause; }
  return next;
}
