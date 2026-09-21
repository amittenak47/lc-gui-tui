/** Saved scratch-board adapters. No parent links or live editors are mutated. */
import type { BoardBlob } from "../canvas/BoardHandle";
import { packEncodedInk, unpackEncodedInk, type EncodedInk } from "../canvas/inkCodec";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import type { VizProgram } from "../viz/schema";
import { getArtifactAsset, putArtifactAsset } from "./artifactAssetStore";
import { parseArtifactAsset, type ArtifactAsset } from "./artifactAssets";
import type { ArtifactContent, ArtifactParent } from "./padArtifacts";
import { contentSpillOnly } from "./contentStore";
import { footnoteWhiteboardKey, type FootnoteWhiteboardContent } from "./footnoteWhiteboardStore";
import { encodedFromRecord, footnoteWhiteboardDocKey, inkPageKeyRange, type InkPageRecord } from "./inkPageStore";
import { openDb, STORE_CONTENT, STORE_INK_PAGES } from "./idb";

type WhiteboardContent = Extract<ArtifactContent, { kind: "whiteboard" }>;
export interface ArtifactWhiteboardSnapshot {
  board: BoardBlob;
  pageCount: number;
  programs: VizProgram[];
  ink: Map<number, EncodedInk>;
}

function requireManifest(board: BoardBlob, pages: Iterable<number>): void {
  const expected = board.inkPages?.pageIds ?? [];
  const actual = new Set(pages);
  if (actual.size !== expected.length || expected.some((id) => !actual.has(id))) {
    throw new Error("Saved whiteboard and ink differ. Save the whiteboard again before attaching it.");
  }
}

/**
 * Caller supplies a flushed saved snapshot, not an in-progress stroke buffer.
 * Return a pointer only after ALL immutable writes commit. Partial failures
 * leave unlinked staging records, never a usable-looking incomplete pointer.
 */
export async function stageWhiteboardArtifactSnapshot(
  parent: ArtifactParent, boardId: string, snapshot: ArtifactWhiteboardSnapshot,
): Promise<WhiteboardContent> {
  requireManifest(snapshot.board, snapshot.ink.keys());
  const revision = crypto.randomUUID();
  const content: WhiteboardContent = {
    kind: "whiteboard", boardId, sceneRevision: revision,
    ink: [...snapshot.ink.keys()].sort((a, b) => a - b).map((pageId) => ({ pageId, revision })),
  };
  // Serialize before the first await, so later editor mutations cannot alter
  // half of a staged revision. Validate every payload before writing any.
  const assets: ArtifactAsset[] = [parseArtifactAsset({
    parent, dependency: { kind: "scene", id: boardId, revision },
    payload: JSON.stringify({ v: 1, board: snapshot.board, pageCount: snapshot.pageCount, programs: snapshot.programs }),
  })];
  for (const page of content.ink) {
    assets.push(parseArtifactAsset({
      parent, dependency: { kind: "ink", id: boardId, revision, pageId: page.pageId },
      payload: JSON.stringify({ v: 1, packed: bytesToB64(packEncodedInk(snapshot.ink.get(page.pageId)!)) }),
    }));
  }
  for (const asset of assets) {
    await putArtifactAsset(asset);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return content;
}

/** Decode a complete immutable snapshot; callers decide whether an editor may open it. */
export async function loadWhiteboardArtifactSnapshot(
  parent: ArtifactParent, content: WhiteboardContent,
): Promise<ArtifactWhiteboardSnapshot> {
  const scene = await getArtifactAsset({ parent, dependency: {
    kind: "scene", id: content.boardId, revision: content.sceneRevision,
  } });
  if (!scene) throw new Error("Attached whiteboard is unavailable. Download its content and retry.");
  const payload = JSON.parse(scene.payload) as { board: BoardBlob; pageCount: number; programs: VizProgram[] };
  requireManifest(payload.board, content.ink.map((page) => page.pageId));
  const ink = new Map<number, EncodedInk>();
  for (const page of content.ink) {
    const dependency = { kind: "ink" as const, id: content.boardId, ...page };
    const asset = await getArtifactAsset({ parent, dependency });
    if (!asset) throw new Error("Attached whiteboard ink is unavailable. Download its content and retry.");
    const decoded = unpackEncodedInk(b64ToBytes(JSON.parse(asset.payload).packed));
    if (!decoded) throw new Error("Attached whiteboard ink is damaged; existing work was kept.");
    ink.set(dependency.pageId, decoded);
  }
  return { ...payload, ink };
}

/**
 * Legacy annotate-owned fnwb storage stays readable. Read scene and shards in
 * ONE readonly transaction, never a sequence of mutable per-page reads. The
 * calling save flow must first flush ink and persist the scene, then guard its
 * parent revision before attaching the result. This does not publish a catalog.
 */
export async function stageSavedFootnoteWhiteboard(docId: string, boardId: string): Promise<WhiteboardContent> {
  if (contentSpillOnly()) throw new Error("Repair local storage before attaching a saved whiteboard.");
  const db = await openDb();
  const docKey = footnoteWhiteboardDocKey(docId, boardId);
  const saved = await new Promise<{ scene: FootnoteWhiteboardContent & { programs?: VizProgram[] }; pages: InkPageRecord[] }>((resolve, reject) => {
    const tx = db.transaction([STORE_CONTENT, STORE_INK_PAGES], "readonly");
    const scene = tx.objectStore(STORE_CONTENT).get(footnoteWhiteboardKey(docId, boardId));
    const pages = tx.objectStore(STORE_INK_PAGES).getAll(inkPageKeyRange(docKey));
    tx.oncomplete = () => resolve({ scene: scene.result, pages: pages.result });
    tx.onabort = () => reject(tx.error ?? new Error("Could not read saved whiteboard."));
    tx.onerror = () => reject(tx.error ?? new Error("Could not read saved whiteboard ink."));
  });
  if (contentSpillOnly()) throw new Error("Local storage changed. Repair storage and retry attaching.");
  if (!saved.scene?.board) throw new Error("Saved whiteboard is missing; existing links were kept.");
  const { ink: inlineRaw, inkC: inlineEncoded, ...board } = saved.scene.board;
  // saveBoard({ assembleInk: false }) writes an EMPTY inline placeholder.
  // Drop only proven-empty placeholders, never the sole copy of old strokes.
  if ((inlineRaw !== undefined && (!Array.isArray(inlineRaw) || inlineRaw.length !== 0)) ||
      (inlineEncoded !== undefined && (!inlineEncoded || inlineEncoded.v !== 2 ||
        !Array.isArray(inlineEncoded.ops) || inlineEncoded.ops.length !== 0 ||
        (inlineEncoded.raw !== undefined && (!Array.isArray(inlineEncoded.raw) || inlineEncoded.raw.length !== 0))))) {
    throw new Error("Open and save this older whiteboard before attaching it.");
  }
  const ink = new Map<number, EncodedInk>();
  for (const page of saved.pages) {
    if (page.v !== 1 || page.docKey !== docKey || !Number.isSafeInteger(page.pageId) || page.pageId < 0 || ink.has(page.pageId)) {
      throw new Error("Saved whiteboard ink identity is invalid.");
    }
    const encoded = await encodedFromRecord(page);
    if (!encoded) throw new Error("Saved whiteboard ink is missing or damaged.");
    // Deleted-page WAL rows can remain as empty records for sync. They are not
    // omitted strokes and must not prevent attachment of a newly saved scene.
    if (!(board.inkPages?.pageIds ?? []).includes(page.pageId) &&
        encoded.v === 2 && Array.isArray(encoded.ops) && encoded.ops.length === 0 &&
        (encoded.raw === undefined || (Array.isArray(encoded.raw) && encoded.raw.length === 0))) continue;
    ink.set(page.pageId, encoded);
  }
  return stageWhiteboardArtifactSnapshot({ kind: "annotate", id: docId }, boardId, {
    ...saved.scene, board, programs: saved.scene.programs ?? [], ink,
  });
}
