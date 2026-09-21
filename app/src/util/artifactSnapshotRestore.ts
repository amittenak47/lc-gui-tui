import { contentSpillOnly, getContent } from "./contentStore";
import { openDb, STORE_CONTENT, STORE_INK_PAGES } from "./idb";
import { getAnnotateDocMeta, getAnnotateDoc } from "./annotateStore";
import { listWhiteboardNotebooks, getWhiteboardNotebook } from "./whiteboardStore";
import { editArtifactCatalog, ArtifactEditConflict } from "./artifactCatalogEdits";
import { stageArtifactSnapshot, type ArtifactSnapshotBundle } from "./artifactSnapshot";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { annotateDocKey, whiteboardDocKey, footnoteWhiteboardDocKey, inkPageKey, inkPageKeyRange, type InkPageRecord } from "./inkPageStore";
import { footnoteWhiteboardKey } from "./footnoteWhiteboardStore";
import { parseSnapshotInk, snapshotInkToBytes } from "./padSnapshotPayload";
import type { PadSnapshot } from "./padSnapshotStore";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import { ARTIFACTS_CHANGED } from "./artifactRepository";
import { bytesFromMaybeGzip } from "./gzip";
import { parseArtifactAsset } from "./artifactAssets";
import { bytesToB64 } from "../api/nativeHttp";

/** Catalog, scene/source, scratch scenes and ink commit together, or not at all. */
export async function restoreArtifactSnapshot(parent: ArtifactParent & { kind: "annotate" | "whiteboard" }, snap: Partial<PadSnapshot>, bundle: ArtifactSnapshotBundle) {
  if (contentSpillOnly()) throw new Error("Repair local storage before restoring attachments.");
  if (!snap.board || snap.board.v !== 1 || !Array.isArray(snap.board.elements) || !snap.board.appState) {
    throw new Error("Snapshot board is invalid; current work was kept.");
  }
  const assertLive = () => {
    const meta = parent.kind === "annotate" ? getAnnotateDocMeta(parent.id) : listWhiteboardNotebooks().find(row => row.id === parent.id);
    if (!meta || meta.deletedAt) throw new Error("The snapshot's parent is unavailable or in Trash.");
    return meta.updatedAt;
  };
  const clock = assertLive();
  const before = await getContent<{ artifacts?: ArtifactCatalog; [key: string]: unknown }>(parent.id);
  if (!before) throw new Error("Save the parent before restoring attachments.");
  const fingerprint = JSON.stringify(before);
  await stageArtifactSnapshot(bundle, parent);
  const artifacts = editArtifactCatalog(before.artifacts, parent, before.artifacts?.revision ?? null,
    { type: "snapshot", catalog: bundle.catalog });
  await downloadArtifactAssets(undefined, artifacts);
  const rows = new Map<string, InkPageRecord[]>();
  const addInk = (key: string, value: unknown) => {
    const pages = parseSnapshotInk(value);
    if (value !== undefined && (!Array.isArray(value) || pages.length !== value.length)) throw new Error("Snapshot ink is invalid.");
    const ids = new Set<number>();
    rows.set(key, pages.map(page => {
      const decoded = snapshotInkToBytes(page);
      if (!decoded || !Number.isSafeInteger(page.pageId) || page.pageId < 0 || ids.has(page.pageId)) throw new Error("Snapshot ink is invalid.");
      ids.add(page.pageId);
      return { v: 1, docKey: key, pageId: page.pageId, gz: decoded.gz, dirty: false, updatedAt: page.updatedAt };
    }));
  };
  addInk(parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id), snap.ink);
  for (const id of new Set([...Object.keys(snap.footnoteBoards ?? {}), ...Object.keys(snap.footnoteInk ?? {})])) {
    addInk(footnoteWhiteboardDocKey(parent.id, id), snap.footnoteInk?.[id]);
  }
  // Validate every shard before the destructive transaction. A valid base64
  // string alone says nothing about whether the saved handwriting can reopen.
  for (const pages of rows.values()) for (const page of pages) {
    parseArtifactAsset({ parent, dependency: { kind: "ink", id: parent.id, revision: "snapshot", pageId: page.pageId },
      payload: JSON.stringify({ v: 1, packed: bytesToB64(await bytesFromMaybeGzip(page.gz!)) }) });
  }
  const requireInk = (key: string, board: PadSnapshot["board"]) => {
    const available = new Set((rows.get(key) ?? []).map(page => page.pageId));
    if (board.inkPages?.pageIds.some(id => !available.has(id))) throw new Error("Snapshot handwriting is incomplete; current work was kept.");
  };
  requireInk(parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id), snap.board);
  for (const [id, scene] of Object.entries(snap.footnoteBoards ?? {})) requireInk(footnoteWhiteboardDocKey(parent.id, id), scene.board);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_CONTENT, STORE_INK_PAGES], "readwrite");
    let failure: unknown;
    const content = tx.objectStore(STORE_CONTENT);
    const request = content.get(parent.id);
    request.onsuccess = () => {
      try {
        if (contentSpillOnly() || assertLive() !== clock || JSON.stringify(request.result) !== fingerprint) throw new ArtifactEditConflict();
        content.put({ ...before, artifacts, board: snap.board,
          ...(snap.agent !== undefined ? { agent: snap.agent } : {}),
          ...(parent.kind === "annotate" ? { ...(snap.source !== undefined ? { source: snap.source } : {}),
            ...(snap.footnotes !== undefined ? { footnotes: snap.footnotes } : {}) } : {}),
        }, parent.id);
        for (const [id, scene] of Object.entries(snap.footnoteBoards ?? {})) content.put(scene, footnoteWhiteboardKey(parent.id, id));
        const ink = tx.objectStore(STORE_INK_PAGES);
        for (const [key, pages] of rows) {
          ink.delete(inkPageKeyRange(key));
          for (const page of pages) ink.put(page, inkPageKey(key, page.pageId));
        }
      } catch (cause) { failure = cause; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Snapshot restore failed; current work was kept."));
    tx.onerror = () => { /* onabort reports the failure */ };
  });
  // Existing getters repair index revision/clock after an interrupted index write.
  if (parent.kind === "annotate") await getAnnotateDoc(parent.id);
  else await getWhiteboardNotebook(parent.id);
  window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: parent }));
}
