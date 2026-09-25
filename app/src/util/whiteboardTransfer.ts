import type { BoardBlob, BoardHandle } from "../canvas/BoardHandle";
import { concatEncodedInk, reviveEncodedInk } from "../canvas/inkCodec";
import { encodedFromRecord, getInkPageRecords, whiteboardDocKey } from "./inkPageStore";
import { captureArtifactSnapshot, parseArtifactSnapshotBundle, stageArtifactSnapshot, type ArtifactSnapshotBundle } from "./artifactSnapshot";
import { getWhiteboardNotebook, saveWhiteboardNotebook, WHITEBOARD_PAGE_LIMIT } from "./whiteboardStore";

export interface WhiteboardBackup {
  format: "whiteboard-annotations";
  version: 1;
  sourceId?: string;
  title: string;
  pageCount: number;
  board: BoardBlob;
  agent: unknown[];
  attachments?: ArtifactSnapshotBundle;
}

/** Snapshot live edits first, then include cold pages without decoding all points. */
export async function captureWhiteboardBackup(board: BoardHandle, id: string | null, title: string, pageCount: number, agent: unknown[], includeAttachments = true): Promise<WhiteboardBackup> {
  const scene = board.saveBoard({ assembleInk: false });
  const live = board.snapshotInkPages();
  const dirty = board.takeDirtyInkPages();
  const pages = new Map([...live].filter(([page,ink]) => dirty.has(page) || ink.ops.length > 0 || (ink.raw?.length ?? 0) > 0));
  for (const [page,ink] of dirty) pages.set(page,ink);
  const saved = id ? await getWhiteboardNotebook(id) : null;
  if (id) for (const row of await getInkPageRecords(whiteboardDocKey(id), { strict: true })) {
    if (pages.has(row.pageId)) continue;
    const ink = await encodedFromRecord(row);
    if (!ink) throw new Error(`Cannot export: handwriting page ${row.pageId} could not be read.`);
    pages.set(row.pageId, ink);
  }
  for (const page of scene.inkPages?.pageIds ?? []) {
    if (!pages.has(page)) throw new Error(`Cannot export: handwriting page ${page} is missing.`);
  }
  const { inkPages: _manifest, ink: _legacy, ...rest } = scene;
  return { format: "whiteboard-annotations", version: 1, sourceId: id ?? undefined,
    title: saved?.title ?? title, pageCount, board: { ...rest, inkC: concatEncodedInk([...pages.values()]) },
    agent, attachments: includeAttachments ? await captureArtifactSnapshot(saved?.artifacts) : undefined };
}

export function readWhiteboardBackup(text: string): WhiteboardBackup {
  const value = JSON.parse(text) as WhiteboardBackup;
  const board = value?.board, state = board?.appState;
  if (value?.format !== "whiteboard-annotations" || value.version !== 1 || typeof value.title !== "string" ||
      !Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > WHITEBOARD_PAGE_LIMIT ||
      board?.v !== 1 || !Array.isArray(board.elements) || !state ||
      ![state.scrollX,state.scrollY,state.zoom].every(Number.isFinite) || state.zoom <= 0 ||
      !Array.isArray(value.agent) || board.inkPages || !reviveEncodedInk(board.inkC)) {
    throw new Error("This is not a complete whiteboard annotation backup.");
  }
  const ink = reviveEncodedInk(board.inkC)!;
  if (ink.ops.some(op => !Number.isInteger(op.n) || op.n < 1 || !Number.isFinite(op.x0) || !Number.isFinite(op.y0) ||
      (op.k !== "d" && op.k !== "e") || op.xy.length !== 2 * (op.n - 1) ||
      [op.pr,op.sl,op.rr].some(channel => channel && channel.length !== op.n))) {
    throw new Error("The whiteboard backup contains damaged handwriting.");
  }
  value.board = { ...board, inkC: ink };
  if (value.attachments) {
    if (!value.sourceId) throw new Error("The attachment backup has no owner.");
    parseArtifactSnapshotBundle(value.attachments, { kind: "whiteboard", id: value.sourceId });
  }
  return value;
}

/** A copy gets a new owner; transcript fields and message IDs remain intact. */
export async function importWhiteboardBackup(text: string) {
  const backup = readWhiteboardBackup(text);
  const id = `wb-import-${crypto.randomUUID()}`;
  const parent = { kind: "whiteboard" as const, id };
  const bundle = backup.attachments ? { ...backup.attachments,
    catalog: { ...backup.attachments.catalog, parent },
    assets: backup.attachments.assets.map(asset => ({ ...asset, parent })),
  } : undefined;
  await stageArtifactSnapshot(bundle, parent);
  const agent = remapWhiteboardRefs(backup.agent, backup.sourceId, id) as unknown[];
  return saveWhiteboardNotebook({ id, title: backup.title, pageCount: backup.pageCount,
    board: backup.board, agent, artifacts: bundle?.catalog });
}

function remapWhiteboardRefs(value: unknown, from: string | undefined, to: string): unknown {
  if (Array.isArray(value)) return value.map(item => remapWhiteboardRefs(item, from, to));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (from && row.kind === "whiteboard" && row.id === from) return { ...row, id: to };
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, remapWhiteboardRefs(item, from, to)]));
}
