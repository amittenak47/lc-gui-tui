/** Parent-owned content. Child documents never enter the standalone library. */
import { getAnnotateDoc, editAnnotateArtifacts } from "./annotateStore";
import { getWhiteboardNotebook, editWhiteboardArtifacts } from "./whiteboardStore";
import { getProblemBoard, editProblemArtifacts } from "./problemBoardStore";
import { type ArtifactCatalogEdit, ArtifactEditConflict } from "./artifactCatalogEdits";
import type { ArtifactParent, ArtifactRef, ArtifactCatalog, ArtifactAssociation, PadArtifact } from "./padArtifacts";
import { stageOwnedDocumentSnapshot, loadOwnedDocumentSnapshot, type ArtifactDocumentSnapshot } from "./artifactDocuments";
import { stageWhiteboardArtifactSnapshot, loadWhiteboardArtifactSnapshot, type ArtifactWhiteboardSnapshot } from "./artifactWhiteboards";

export const ARTIFACTS_CHANGED = "lc-artifacts-changed";
export type ArtifactSnapshot =
  | { kind: "whiteboard"; value: ArtifactWhiteboardSnapshot }
  | { kind: "code" | "markdown"; value: ArtifactDocumentSnapshot };

export async function readArtifactCatalog(parent: ArtifactParent): Promise<ArtifactCatalog | undefined> {
  const record = parent.kind === "annotate" ? await getAnnotateDoc(parent.id) :
    parent.kind === "whiteboard" ? await getWhiteboardNotebook(parent.id) : await getProblemBoard(parent.id);
  if (!record || ("deletedAt" in record && record.deletedAt)) throw new Error("The attachment's parent is unavailable or in Trash.");
  return record.artifacts;
}

export async function mutateArtifacts(parent: ArtifactParent, base: string | null, edit: ArtifactCatalogEdit) {
  const catalog = await (parent.kind === "annotate" ? editAnnotateArtifacts(parent.id, base, edit) :
    parent.kind === "whiteboard" ? editWhiteboardArtifacts(parent.id, base, edit) : editProblemArtifacts(parent.id, base, edit));
  window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: parent }));
  return catalog;
}

export function artifactRef(parent: ArtifactParent, item: PadArtifact): ArtifactRef {
  return { parent, artifactId: item.id, kind: item.content.kind };
}

export async function readArtifact(ref: ArtifactRef) {
  const catalog = await readArtifactCatalog(ref.parent);
  const item = catalog?.artifacts.find(item => item.id === ref.artifactId);
  if (!item) throw new Error("Attachment unavailable. Sync its parent and retry.");
  if (item.deletedAt !== undefined) throw new Error("This attachment is in Trash. Restore it from Attachments.");
  if (item.content.kind !== ref.kind) throw new Error("Attachment kind does not match its reference.");
  const snapshot: ArtifactSnapshot = item.content.kind === "whiteboard"
    ? { kind: "whiteboard", value: await loadWhiteboardArtifactSnapshot(ref.parent, item.content) }
    : { kind: item.content.kind, value: await loadOwnedDocumentSnapshot(ref.parent, item.content) };
  return { catalog: catalog!, item, snapshot };
}

async function stage(parent: ArtifactParent, contentId: string, snapshot: ArtifactSnapshot) {
  return snapshot.kind === "whiteboard" ? stageWhiteboardArtifactSnapshot(parent, contentId, snapshot.value) :
    stageOwnedDocumentSnapshot(parent, contentId, snapshot.value);
}

export async function createArtifact(parent: ArtifactParent, title: string, associations: ArtifactAssociation[], snapshot: ArtifactSnapshot): Promise<ArtifactRef> {
  const before = await readArtifactCatalog(parent);
  const id = crypto.randomUUID();
  const content = await stage(parent, crypto.randomUUID(), snapshot);
  const catalog = await mutateArtifacts(parent, before?.revision ?? null, { type: "create", id, title, associations, content });
  return artifactRef(parent, catalog.artifacts.find(item => item.id === id)!);
}

/** A dirty editor always names its base. Never refresh that base behind its back. */
export async function saveArtifact(ref: ArtifactRef, expectedRevision: string, title: string, snapshot: ArtifactSnapshot) {
  const before = await readArtifactCatalog(ref.parent);
  const item = before?.artifacts.find(entry => entry.id === ref.artifactId);
  if (!item || item.deletedAt !== undefined || item.revision !== expectedRevision) throw new ArtifactEditConflict();
  if (snapshot.kind !== item.content.kind) throw new Error("Use Save a copy to change attachment kind.");
  const content = await stage(ref.parent, item.content.kind === "whiteboard" ? item.content.boardId : item.content.documentId, snapshot);
  const catalog = await mutateArtifacts(ref.parent, before!.revision, { type: "update", id: item.id,
    expectedRevision, patch: { title, content } });
  return catalog.artifacts.find(entry => entry.id === item.id)!;
}
