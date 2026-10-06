/**
 * Live LeetCode canvas working copy. Hub `pads.db` is the LAN copy.
 * Attempt history stays on the PC under `.lc/attempts/`.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, STORE_PROBLEM_BOARDS, STORE_SYNC_RECOVERY } from "./idb";
import { newBookToken } from "./bookCoordinator";
import { artifactCatalogFields, type ArtifactCatalog } from "./padArtifacts";
import { ArtifactEditConflict, editArtifactCatalog, requireArtifactCatalogTransition, type ArtifactCatalogEdit } from "./artifactCatalogEdits";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { mergeAgentMessages } from "../modes/coachSessions";
import { mutateLocalBook, readFallbackContent, hasFallbackContent } from "./localBookStore";

export function problemPadId(dataset: string, taskId: string): string {
  return `${dataset.trim()}/${taskId.trim()}`;
}

export interface ProblemBoardRecord {
  /** Unknown authored wire fields survive download, editing and re-upload. */
  authoredExtras?: Record<string, unknown>;
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
  const fallback = readFallbackContent<ProblemBoardRecord>(id);
  if (hasFallbackContent(id)) return fallback ? { ...fallback, ...artifactCatalogFields(fallback.artifacts, { kind: "problem", id }) } : null;
  const row = await run<ProblemBoardRecord | undefined>(
    STORE_PROBLEM_BOARDS,
    "readonly",
    (store) => store.get(id),
  );
  return row ? { ...row, ...artifactCatalogFields(row.artifacts, { kind: "problem", id }) } : null;
}

function recordMetadata(row: ProblemBoardRecord) {
  const { board: _board, agent: _agent, artifacts: _artifacts, ...meta } = row;
  return { ...meta, kind: "problem" as const };
}

export async function putProblemBoard(row: ProblemBoardRecord): Promise<void> {
  const supplied = artifactCatalogFields(row.artifacts, { kind: "problem", id: row.id });
  await mutateLocalBook({ kind: "problem", id: row.id }, { contentStore: STORE_PROBLEM_BOARDS }, ctx => {
    const current = ctx.content as ProblemBoardRecord | null;
    const artifacts = requireArtifactCatalogTransition(current?.artifacts, supplied.artifacts, { kind: "problem", id: row.id });
    if (current?.artifacts && supplied.artifacts && current.artifacts.revision !== supplied.artifacts.revision) throw new ArtifactEditConflict();
    const saved = { ...current, ...row, ...(artifacts ? { artifacts } : {}),
      agent: mergeAgentMessages(current?.agent ?? [], row.agent ?? [], false) };
    if (!current && ctx.state.lifecycle?.action === "delete") {
      saved.syncSeq = Math.max(saved.syncSeq ?? 0, ctx.state.lifecycle.seq) + 1;
      ctx.markLifecycle("restore", saved.syncSeq, ctx.state.bootstrap ? null : ctx.state.appliedBookRev, ctx.state.lifecycle.goneSeq);
    }
    ctx.setContent(saved);
    ctx.setMetadata({ ...ctx.metadata, ...recordMetadata(saved) });
  });
}

export async function deleteProblemBoard(id: string): Promise<void> {
  await mutateLocalBook({ kind: "problem", id }, { contentStore: STORE_PROBLEM_BOARDS, requireIdb: true, extraStores: [STORE_SYNC_RECOVERY] }, ctx => {
    const current = ctx.content as ProblemBoardRecord | null;
    if (!current) return;
    if (ctx.tx) {
      const retainedId = `problem-delete:${newBookToken()}`;
      ctx.tx.objectStore(STORE_SYNC_RECOVERY).add({ id: retainedId, type: "record", kind: "problem", bookId: id,
        provenance: { source: "problem-delete" }, record: { meta: ctx.metadata ?? recordMetadata(current), payload: current } }, retainedId);
    }
    ctx.setContent(null); ctx.setMetadata(null);
    ctx.markLifecycle("delete", (current.syncSeq ?? 0) + 1, ctx.state.bootstrap ? null : ctx.state.appliedBookRev, null);
  });
}

/** A download/conflict choice may replace only the exact version it examined. */
export async function replaceProblemBoard(expected: ProblemBoardRecord | null, row: ProblemBoardRecord): Promise<void> {
  await downloadArtifactAssets(undefined, row.artifacts);
  await mutateLocalBook({ kind: "problem", id: row.id }, { contentStore: STORE_PROBLEM_BOARDS, requireIdb: true }, ctx => {
    const current = ctx.content as ProblemBoardRecord | null;
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ArtifactEditConflict();
    const artifacts = requireArtifactCatalogTransition(current?.artifacts, row.artifacts, { kind: "problem", id: row.id });
    const saved = { ...current, ...row, ...(artifacts ? { artifacts } : {}), agent: mergeAgentMessages(current?.agent ?? [], row.agent ?? []) };
    ctx.setContent(saved); ctx.setMetadata({ ...ctx.metadata, ...recordMetadata(saved) });
  });
}

export async function markProblemHubAck(id: string, updatedAt: number): Promise<void> {
  await mutateLocalBook({ kind: "problem", id }, { contentStore: STORE_PROBLEM_BOARDS, authored: false }, ctx => {
    const row = ctx.content as ProblemBoardRecord | null;
    if (row) {
      const saved = { ...row, hubAckUpdatedAt: Math.max(row.hubAckUpdatedAt ?? 0, updatedAt) };
      ctx.setContent(saved); ctx.setMetadata({ ...ctx.metadata, ...recordMetadata(saved) });
    }
  });
}

/** Merge the accepted transcript while preserving the current problem scene. */
export async function acceptProblemHubAgent(id: string, agent: unknown): Promise<void> {
  if (!Array.isArray(agent)) return;
  await mutateLocalBook({ kind: "problem", id }, { contentStore: STORE_PROBLEM_BOARDS, authored: false }, ctx => {
    const row = ctx.content as ProblemBoardRecord | null;
    if (row) ctx.setContent({ ...row, agent: mergeAgentMessages(row.agent ?? [], agent) });
  });
}

export async function editProblemArtifacts(
  id: string, expectedCatalogRevision: string | null, edit: ArtifactCatalogEdit,
): Promise<ArtifactCatalog> {
  const initial = await getProblemBoard(id);
  if (!initial) throw new Error("Save the problem board before attaching content.");
  const next = editArtifactCatalog(initial.artifacts, { kind: "problem", id }, expectedCatalogRevision, edit);
  await downloadArtifactAssets(undefined, next);
  return mutateLocalBook({ kind: "problem", id }, { contentStore: STORE_PROBLEM_BOARDS, requireIdb: true }, ctx => {
    const current = ctx.content as ProblemBoardRecord | null;
    const catalog = artifactCatalogFields(current?.artifacts, { kind: "problem", id }).artifacts;
    if (!current || (catalog?.revision ?? null) !== expectedCatalogRevision) throw new ArtifactEditConflict();
    const artifacts = requireArtifactCatalogTransition(catalog, next, { kind: "problem", id })!;
    if (catalog?.revision === artifacts.revision) return artifacts;
    const saved = { ...current, artifacts, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    ctx.setContent(saved); ctx.setMetadata({ ...ctx.metadata, ...recordMetadata(saved) });
    return artifacts;
  });
}
