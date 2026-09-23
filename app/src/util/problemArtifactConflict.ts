import type { LcClient, ProblemPadDto, WhiteboardPadDto } from "../api/client";
import type { BoardBlob } from "../canvas/BoardHandle";
import type { HubInkChoice, HubPadConflict } from "./hubConflictStash";
import { getProblemBoard, replaceProblemBoard, type ProblemBoardRecord } from "./problemBoardStore";
import { prepareArtifactConflict } from "./artifactConflict";
import { editArtifactCatalog } from "./artifactCatalogEdits";
import { stageWhiteboardArtifactSnapshot } from "./artifactWhiteboards";
import { mergeAgentMessages } from "../modes/coachSessions";
import { encodeInkOps, inkOpsFrom, packEncodedInk } from "../canvas/inkCodec";
import { bytesToB64 } from "../api/nativeHttp";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import type { ArtifactWhiteboardSnapshot } from "./artifactWhiteboards";

/** A notebook needs one page frame spanning the preserved problem canvas. */
export function problemCanvasSnapshot(source: BoardBlob): ArtifactWhiteboardSnapshot {
  const board = structuredClone(source);
  const ops = inkOpsFrom(board);
  let minX = 0, minY = 0, maxX = 400, maxY = 400;
  board.elements = board.elements.map(raw => {
    const el = raw as { x?: number; y?: number; width?: number; height?: number; customData?: Record<string, unknown> };
    if (Number.isFinite(el.x) && Number.isFinite(el.y)) {
      minX = Math.min(minX, el.x!); minY = Math.min(minY, el.y!);
      maxX = Math.max(maxX, el.x! + (el.width ?? 0)); maxY = Math.max(maxY, el.y! + (el.height ?? 0));
    }
    return { ...el, customData: { ...el.customData, lcRegion: "pad-0", lcRegionFrame: false } };
  });
  for (const op of ops) for (const point of op.points) {
    minX = Math.min(minX, point.x - 32); minY = Math.min(minY, point.y - 32);
    maxX = Math.max(maxX, point.x + 32); maxY = Math.max(maxY, point.y + 32);
  }
  const frame = convertToExcalidrawElements([{ type: "rectangle", x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    strokeColor: "transparent", backgroundColor: "transparent", locked: true,
    customData: { lcRegion: "pad-0", lcRegionFrame: true } }]);
  board.elements = [...frame, ...board.elements];
  delete board.ink; delete board.inkC;
  board.inkPages = { v: 1, pageIds: [0] };
  return { board, ink: new Map([[0, encodeInkOps(ops)]]), pageCount: 1, programs: [] };
}

export interface ProblemArtifactConflict { local: ProblemBoardRecord; server: ProblemPadDto }
const conflicts = new Map<string, ProblemArtifactConflict>();
const listeners = new Set<() => void>();
export function stashProblemArtifactConflict(local: ProblemBoardRecord, server: ProblemPadDto) {
  if (server.id !== local.id || !server.board) throw new Error("The conflicting problem could not be read. Local work was kept.");
  if (JSON.stringify(conflicts.get(local.id)) === JSON.stringify({ local, server })) return;
  conflicts.set(local.id, structuredClone({ local, server }));
  for (const listener of listeners) listener();
}
export const problemArtifactConflict = (id: string) => conflicts.get(id);
export function clearProblemArtifactConflict(id: string) {
  if (!conflicts.delete(id)) return;
  for (const listener of listeners) listener();
}
export function subscribeProblemArtifactConflict(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The existing canvas comparison accepts notebook-shaped preview data. */
export function problemConflictPreview(conflict: ProblemArtifactConflict): HubPadConflict {
  const { local, server } = conflict;
  const view = (board: unknown, agent: unknown, updated_at: number, artifacts: ProblemPadDto["artifacts"]): WhiteboardPadDto => ({
    id: local.id, title: local.taskId, page_count: 1, updated_at, board, agent, artifacts,
  });
  const ink = (blob: unknown, updated_at: number) => [{ kind: "whiteboard" as const, key: local.id, page_id: 1, updated_at, gz: bytesToB64(packEncodedInk(encodeInkOps(inkOpsFrom(blob as BoardBlob)))) }];
  return { kind: "whiteboard", id: local.id, stage: "pad", wholeCanvas: true,
    detail: "This problem changed on both devices. Keep both saves the other canvas as an attachment; differing attachments become conflict copies.",
    local: view(local.board, local.agent ?? [], local.updatedAt, local.artifacts),
    server: view(server.board, server.agent, server.updated_at, server.artifacts),
    localInk: ink(local.board, local.updatedAt), serverInk: ink(server.board, server.updated_at),
    localInkStamps: [{ pageId: 1, updatedAt: local.updatedAt }],
    hubInkStamps: [{ pageId: 1, updatedAt: server.updated_at }],
  };
}

export async function resolveProblemArtifactConflict(client: LcClient, conflict: ProblemArtifactConflict, preference: "local" | "server" | "merged", inkChoice?: HubInkChoice) {
  const { local, server } = conflict;
  const current = await getProblemBoard(local.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(local)) {
    if (current) stashProblemArtifactConflict(current, server);
    throw new Error("The problem changed while the comparison was open. Review the refreshed copies.");
  }
  const parent = { kind: "problem" as const, id: local.id };
  let artifacts = await prepareArtifactConflict(client, parent, local.artifacts, server.artifacts, preference === "server" ? "server" : "local");
  if (preference === "merged") {
    // Both canvases remain editable, without layering two independent scenes.
    const content = await stageWhiteboardArtifactSnapshot(parent, crypto.randomUUID(), problemCanvasSnapshot(server.board as BoardBlob));
    artifacts = editArtifactCatalog(artifacts, parent, artifacts?.revision ?? null, { type: "create", id: crypto.randomUUID(),
      title: `${local.taskId} (conflict copy)`, content, associations: [{ kind: "file" }] });
  }
  const row: ProblemBoardRecord = { ...local, artifacts,
    ...(preference === "server" ? { board: server.board as BoardBlob } : {}),
    agent: mergeProblemAgent(local.agent ?? [], Array.isArray(server.agent) ? server.agent : []),
    updatedAt: Math.max(Date.now(), local.updatedAt + 1, server.updated_at + 1),
    hubAckUpdatedAt: server.updated_at, syncSeq: server.sync_seq,
  };
  if (inkChoice === "none") {
    row.board = { ...row.board, inkC: encodeInkOps([]) };
    delete row.board.ink; delete row.board.inkPages;
  }
  await replaceProblemBoard(local, row);
  conflicts.delete(local.id);
  return row;
}

function mergeProblemAgent(local: unknown[], remote: unknown[]): unknown[] {
  return mergeAgentMessages(local, remote);
}
