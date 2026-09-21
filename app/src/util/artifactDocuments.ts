/** Owned text attachment snapshots; imported disk files are never written. */
import type { BoardBlob } from "../canvas/BoardHandle";
import { packEncodedInk, unpackEncodedInk, type EncodedInk } from "../canvas/inkCodec";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import type { DocFootnote } from "./docFootnotes";
import type { ArtifactContent, ArtifactParent } from "./padArtifacts";
import { getArtifactAsset, putArtifactAsset } from "./artifactAssetStore";
import { parseArtifactAsset } from "./artifactAssets";

type DocumentContent = Extract<ArtifactContent, { kind: "code" | "markdown" }>;
export interface ArtifactDocumentSnapshot {
  owned: true;
  docType: "code" | "markdown";
  name: string;
  source: string;
  board: BoardBlob;
  footnotes: DocFootnote[];
  agent: unknown[];
  ink: Map<number, EncodedInk>;
}

/**
 * A document revision covers source AND annotations/ink/transcript. Publishing
 * just new source would otherwise strand annotations on a different revision.
 * Caller must supply a flushed snapshot and separately commit the parent link.
 */
export async function stageOwnedDocumentSnapshot(
  parent: ArtifactParent, documentId: string, snapshot: ArtifactDocumentSnapshot,
): Promise<DocumentContent> {
  // Legacy nested scratch pointers have mutable external dependencies not
  // included in this bundle. Never advertise such a document as complete.
  if (snapshot.footnotes.some((note) => note.whiteboards?.length)) {
    throw new Error("Documents containing legacy nested scratch boards are not supported as attachments yet. The original document was kept.");
  }
  const sourceRevision = crypto.randomUUID();
  const ink = [...snapshot.ink].sort(([a], [b]) => a - b).map(([pageId, encoded]) => ({
    pageId, packed: bytesToB64(packEncodedInk(encoded)),
  }));
  // Snapshot all mutable data before awaiting storage; no editor buffer is
  // changed and no library entry is created by this transfer operation.
  const asset = parseArtifactAsset({
    parent, dependency: { kind: "document", id: documentId, revision: sourceRevision },
    payload: JSON.stringify({
      v: 1, owned: snapshot.owned, docType: snapshot.docType, name: snapshot.name,
      source: snapshot.source, board: snapshot.board, footnotes: snapshot.footnotes,
      agent: snapshot.agent, ink,
    }),
  });
  await putArtifactAsset(asset);
  return { kind: snapshot.docType, documentId, sourceRevision };
}

/** Decode for the existing Monaco/Markdown open flow; never overwrite its buffer. */
export async function loadOwnedDocumentSnapshot(
  parent: ArtifactParent, content: DocumentContent,
): Promise<ArtifactDocumentSnapshot> {
  const asset = await getArtifactAsset({ parent, dependency: {
    kind: "document", id: content.documentId, revision: content.sourceRevision,
  } });
  if (!asset) throw new Error("Attached document is unavailable. Download its content and retry.");
  const payload = JSON.parse(asset.payload) as Omit<ArtifactDocumentSnapshot, "ink"> & {
    ink: Array<{ pageId: number; packed: string }>;
  };
  if (payload.docType !== content.kind) throw new Error("Attached document kind does not match its link.");
  const ink = new Map<number, EncodedInk>();
  for (const page of payload.ink) {
    const encoded = unpackEncodedInk(b64ToBytes(page.packed));
    if (!encoded) throw new Error("Attached document ink is damaged; existing work was kept.");
    ink.set(page.pageId, encoded);
  }
  return { owned: true, docType: payload.docType, name: payload.name, source: payload.source,
    board: payload.board, footnotes: payload.footnotes, agent: payload.agent, ink };
}
