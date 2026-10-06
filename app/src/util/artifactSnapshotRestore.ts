import type { BoardBlob } from "../canvas/BoardHandle";
import { encodeInkOps, packEncodedInk, reviveEncodedInk } from "../canvas/inkCodec";
import { contentSpillOnly, getContent } from "./contentStore";
import { STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY, withStore } from "./idb";
import { newBookToken } from "./bookCoordinator";
import { hashMarkdown } from "./annotateStore";
import { editArtifactCatalog, ArtifactEditConflict } from "./artifactCatalogEdits";
import { stageArtifactSnapshot, type ArtifactSnapshotBundle } from "./artifactSnapshot";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { annotateDocKey, authoredInkRow, encodedFromRecord, getInkPageRecords,
  inkPageKey, whiteboardDocKey, footnoteWhiteboardDocKey, type InkPageRecord } from "./inkPageStore";
import { parseSnapshotInk, snapshotInkToBytes } from "./padSnapshotPayload";
import type { PadSnapshot } from "./padSnapshotStore";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import { ARTIFACTS_CHANGED } from "./artifactRepository";
import { mutateLocalBook } from "./localBookStore";
import { getBookSyncState } from "./syncState";
import { validateInk, validatePackedInk } from "./syncContent";

type SnapshotParent = ArtifactParent & { kind: "annotate" | "whiteboard" };
function validBoard(board: unknown): board is BoardBlob {
  const row = board as BoardBlob | undefined;
  return !!row && row.v === 1 && Array.isArray(row.elements) && !!row.appState && typeof row.appState === "object";
}

/** Capture all owned shards, including historic erasures and unreferenced children. */
async function currentInk(parent: SnapshotParent): Promise<InkPageRecord[]> {
  const primary = parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id);
  const rows = await getInkPageRecords(primary, { strict: true });
  if (parent.kind === "annotate") {
    const prefix = `fnwb:${parent.id}:`;
    await withStore(STORE_INK_PAGES, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        rows.push(cursor.value as InkPageRecord);
        cursor.continue();
      };
    });
  }
  for (const row of rows) {
    const encoded = await encodedFromRecord(row);
    if (!encoded) throw new Error("Current handwriting is unreadable; the snapshot and current work were kept.");
    validatePackedInk(packEncodedInk(encoded));
  }
  return rows;
}

/** Metadata, content, children, ink and tracking share one local commit. */
export async function restorePadSnapshotLocally(parent: SnapshotParent, snap: Partial<PadSnapshot>, bundle?: ArtifactSnapshotBundle): Promise<void> {
  if (contentSpillOnly()) throw new Error("Repair local storage before restoring a snapshot.");
  if (!validBoard(snap.board)) throw new Error("Snapshot board is invalid; current work was kept.");
  const capturedState = await getBookSyncState(parent.kind, parent.id);
  const before = await getContent<{ artifacts?: ArtifactCatalog; [key: string]: unknown }>(parent.id);
  const fingerprint = JSON.stringify(before);
  const previousInk = await currentInk(parent);
  const previousChildren: Record<string, unknown> = {};
  if (parent.kind === "annotate") await withStore(STORE_CONTENT, "readonly", store => {
    const prefix = `fnwb:${parent.id}:`;
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { previousChildren[String(cursor.key)] = cursor.value; cursor.continue(); }
    };
  });
  let artifacts: ArtifactCatalog | undefined;
  if (bundle) {
    await stageArtifactSnapshot(bundle, parent);
    artifacts = editArtifactCatalog(before?.artifacts, parent, before?.artifacts?.revision ?? null,
      { type: "snapshot", catalog: bundle.catalog });
    await downloadArtifactAssets(undefined, artifacts);
  }
  const rows = new Map<string, InkPageRecord[]>();
  const primary = parent.kind === "annotate" ? annotateDocKey(parent.id) : whiteboardDocKey(parent.id);
  const addInk = async (docKey: string, value: unknown, board?: BoardBlob) => {
    const pages = parseSnapshotInk(value);
    if (value !== undefined && (!Array.isArray(value) || pages.length !== value.length)) throw new Error("Snapshot ink is invalid; current work was kept.");
    const ids = new Set<number>();
    const prepared: InkPageRecord[] = [];
    for (const page of pages) {
      const decoded = snapshotInkToBytes(page);
      if (!decoded || !Number.isSafeInteger(page.pageId) || page.pageId < 0 || ids.has(page.pageId)) throw new Error("Snapshot ink is invalid; current work was kept.");
      ids.add(page.pageId);
      await validateInk(decoded.gz);
      prepared.push({ v: 1, docKey, pageId: page.pageId, gz: decoded.gz, dirty: false, updatedAt: page.updatedAt });
    }
    // Verify and convert older inline backups before replacing live shards.
    // Retain the original inline blob as well.
    if (value === undefined && board && (board.inkC !== undefined || board.ink !== undefined)) {
      const revived = board.inkC !== undefined ? reviveEncodedInk(board.inkC) : encodeInkOps(board.ink ?? []);
      if (!revived) throw new Error("Snapshot inline handwriting is unreadable; current work was kept.");
      // The historical reviver restores typed arrays but omits the layout tag.
      const encoded = { ...board.inkC, ...revived };
      validatePackedInk(packEncodedInk(encoded));
      prepared.push({ v: 1, docKey, pageId: docKey.startsWith("md:") ? 0 : 1,
        inkC: encoded, dirty: true, updatedAt: snap.writtenAt ?? Date.now() });
    }
    const available = new Set(prepared.map(page => page.pageId));
    if (board?.inkPages?.pageIds.some(id => !available.has(id))) throw new Error("Snapshot handwriting is incomplete; current work was kept.");
    rows.set(docKey, prepared);
  };
  await addInk(primary, snap.ink, snap.board);
  const childIds = new Set([...Object.keys(snap.footnoteBoards ?? {}), ...Object.keys(snap.footnoteInk ?? {})]);
  for (const id of childIds) {
    if (!id || id.includes(":")) throw new Error("Snapshot scratch-board identity is invalid.");
    const child = snap.footnoteBoards?.[id];
    if (!child || !validBoard(child.board)) throw new Error("Snapshot scratch board is missing; current work was kept.");
    await addInk(footnoteWhiteboardDocKey(parent.id, id), snap.footnoteInk?.[id], child.board);
  }
  const recoveredHash = parent.kind === "annotate" && typeof snap.source === "string" ? await hashMarkdown(snap.source) : undefined;
  const now = Date.now();
  await mutateLocalBook(parent, { requireIdb: true, extraStores: [STORE_INK_PAGES, STORE_SYNC_RECOVERY] }, ctx => {
    if (!ctx.tx || contentSpillOnly() || JSON.stringify(ctx.content) !== fingerprint
      || ctx.state.changeSeq !== (capturedState?.changeSeq ?? 1)) throw new ArtifactEditConflict();
    if (parent.kind === "annotate" && !ctx.metadata && recoveredHash === undefined) {
      throw new Error("This backup's source identity is unavailable. Choose an existing document to restore it; the backup was kept.");
    }
    if (before || previousInk.length || Object.keys(previousChildren).length) {
      const id = `snapshot-restore:${newBookToken()}`;
      ctx.tx.objectStore(STORE_SYNC_RECOVERY).put({ id, type: "conflict", kind: parent.kind, bookId: parent.id,
        provenance: { source: "snapshot-restore", snapshotId: snap.snapshotId ?? null },
        content: { metadata: ctx.metadata, payload: before, children: previousChildren, ink: previousInk } }, id);
    }
    const meta = { ...ctx.metadata, ...parent, updatedAt: now, lastTouch: now,
      ...(parent.kind === "whiteboard" ? { title: snap.name ?? ctx.metadata?.title ?? "Recovered notebook",
        pageCount: snap.pageCount ?? ctx.metadata?.pageCount ?? 1 }
        : { name: snap.name ?? ctx.metadata?.name ?? "Recovered note.md",
          hash: ["pdf", "epub"].includes(String(ctx.metadata?.docType))
            ? ctx.metadata?.hash : recoveredHash ?? ctx.metadata?.hash,
          docType: ctx.metadata?.docType ?? "markdown" }) };
    if (ctx.metadata?.deletedAt || ctx.metadata?.purgedAt) {
      const seq = Math.max(Number(ctx.metadata.syncSeq ?? 0), ctx.state.lifecycle?.seq ?? 0) + 1;
      Object.assign(meta, { deletedAt: undefined, purgedAt: undefined, deleteAcked: false, syncSeq: seq });
      ctx.markLifecycle("restore", seq, ctx.state.bootstrap ? null : ctx.state.appliedBookRev, ctx.state.lifecycle?.goneSeq ?? null);
    }
    ctx.setMetadata(meta);
    ctx.setContent({ ...before, board: snap.board,
      ...(artifacts ? { artifacts } : {}),
      ...(snap.agent !== undefined ? { agent: snap.agent } : { agent: before?.agent ?? [] }),
      ...(parent.kind === "annotate" ? { source: snap.source ?? before?.source ?? "",
        footnotes: snap.footnotes ?? before?.footnotes ?? [] } : {}) });
    const content = ctx.tx.objectStore(STORE_CONTENT);
    if (parent.kind === "annotate") {
      const prefix = `fnwb:${parent.id}:`;
      content.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      for (const [id, scene] of Object.entries(snap.footnoteBoards ?? {})) content.put(scene, `fnwb:${parent.id}:${id}`);
    }
    const ink = ctx.tx.objectStore(STORE_INK_PAGES);
    const previousBy = new Map(previousInk.map(row => [inkPageKey(row.docKey, row.pageId), row]));
    const desired = new Map<string, InkPageRecord>();
    for (const [docKey, pages] of rows) for (const row of pages) desired.set(inkPageKey(docKey, row.pageId), row);
    for (const previous of previousInk) {
      const key = inkPageKey(previous.docKey, previous.pageId);
      if (!desired.has(key)) desired.set(key, { v: 1, docKey: previous.docKey, pageId: previous.pageId,
        inkC: encodeInkOps([]), dirty: true, updatedAt: now });
    }
    for (const [key, next] of desired) {
      const captured = previousBy.get(key);
      const request = ink.get(key);
      request.onsuccess = () => {
        const current = request.result as InkPageRecord | undefined;
        if ((current?.changeSeq ?? null) !== (captured?.changeSeq ?? null)
          || (current?.updatedAt ?? null) !== (captured?.updatedAt ?? null)) { ctx.tx!.abort(); return; }
        ink.put(authoredInkRow({ ...next, updatedAt: Math.max(now, (current?.updatedAt ?? 0) + 1) }, current, ctx.seq), key);
      };
    }
  });
  if (bundle && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: parent }));
}

export async function restoreArtifactSnapshot(parent: SnapshotParent, snap: Partial<PadSnapshot>, bundle: ArtifactSnapshotBundle): Promise<void> {
  return restorePadSnapshotLocally(parent, snap, bundle);
}
