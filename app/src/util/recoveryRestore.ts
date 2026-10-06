/** Explicit retained-copy choices restore local state; no network is involved. */
import { readRecoveryCopy, type RecoveryCopy } from "./syncRecovery";
import { STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY, run, withStore } from "./idb";
import { getBookSyncState, type BookIdentity, type BookMeta } from "./syncState";
import { mutateLocalBook, ensureBookReadyForAtomicSync } from "./localBookStore";
import { newBookToken, hasBookLocks } from "./bookCoordinator";
import { getDocBytes } from "./docBytes";
import { artifactCatalogFields } from "./padArtifacts";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { encodedFromRecord, getInkPageRecords, type InkPageRecord } from "./inkPageStore";
import { packEncodedInk } from "../canvas/inkCodec";
import { validatePackedInk } from "./syncContent";
import { notifyBookMetadataChanged } from "./localBookStore";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function board(value: unknown): value is Record<string, unknown> {
  return object(value) && value.v === 1 && Array.isArray(value.elements) && object(value.appState);
}
export async function restoreRetainedRecord(id: string): Promise<BookIdentity> {
  const copy = await readRecoveryCopy(id);
  if (!copy?.record || copy.type !== "record" || !copy.kind || !copy.bookId) throw new Error("This retained copy is not a complete book.");
  const owner = { kind: copy.kind, id: copy.bookId };
  if (hasBookLocks()) await ensureBookReadyForAtomicSync(owner);
  const record = copy.record;
  if (record.meta.kind !== owner.kind || record.meta.id !== owner.id || !board(record.payload.board)) throw new Error("This retained book is unreadable. The copy was kept.");
  const capturedState = await getBookSyncState(owner.kind, owner.id);
  const contentStore = owner.kind === "problem" ? "problem_boards" : STORE_CONTENT;
  const current = await run(contentStore, "readonly", store => store.get(owner.id));
  const children: Record<string, unknown> = {};
  const ink: InkPageRecord[] = [];
  if (owner.kind !== "problem") ink.push(...await getInkPageRecords(`${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`, { strict: true }));
  if (owner.kind === "annotate") {
    const prefix = `fnwb:${owner.id}:`;
    await withStore(STORE_CONTENT, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { children[String(cursor.key)] = cursor.value; cursor.continue(); } };
    });
    await withStore(STORE_INK_PAGES, "readonly", store => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { ink.push(cursor.value); cursor.continue(); } };
    });
  }
  for (const page of ink) {
    const encoded = await encodedFromRecord(page);
    if (!encoded) throw new Error("Current handwriting cannot be read. Both copies were kept.");
    validatePackedInk(packEncodedInk(encoded));
  }
  const requirePages = (scene: unknown, docKey: string) => {
    if (!board(scene)) throw new Error("A retained scratch board is unreadable. The copy was kept.");
    const manifest = scene.inkPages;
    if (manifest !== undefined && (!object(manifest) || !Array.isArray(manifest.pageIds)
      || manifest.pageIds.some(pageId => !ink.some(page => page.docKey === docKey && page.pageId === pageId)))) {
      throw new Error("This retained copy references missing handwriting. Its original data was kept.");
    }
  };
  if (owner.kind !== "problem") requirePages(record.payload.board, `${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`);
  for (const [childId, child] of Object.entries(record.children ?? {})) {
    if (owner.kind !== "annotate" || !childId || childId.includes(":") || !object(child)) throw new Error("This retained scratch-board identity is invalid.");
    requirePages(child.board, `fnwb:${owner.id}:${childId}`);
  }
  if (owner.kind === "annotate") {
    const footnotes = record.payload.footnotes;
    if (footnotes !== undefined && !Array.isArray(footnotes)) throw new Error("This retained book's footnotes are unreadable. The copy was kept.");
    for (const footnote of Array.isArray(footnotes) ? footnotes : []) {
      if (!object(footnote)) throw new Error("This retained footnote is unreadable. The copy was kept.");
      for (const reference of Array.isArray(footnote.whiteboards) ? footnote.whiteboards : []) {
        if (!object(reference) || typeof reference.id !== "string" || !record.children?.[reference.id]) {
          throw new Error("This retained book references a missing scratch board. The copy was kept.");
        }
      }
    }
  }
  if (owner.kind === "annotate" && ["pdf", "epub"].includes(String(record.meta.docType))) {
    if (typeof record.meta.hash !== "string" || !await getDocBytes(record.meta.hash)) throw new Error("This retained book's source file is missing. The copy was kept.");
  }
  const catalog = artifactCatalogFields(record.payload.artifacts, owner).artifacts;
  await downloadArtifactAssets(undefined, catalog);
  await mutateLocalBook(owner, { requireIdb: true, contentStore, extraStores: [STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_RECOVERY] }, ctx => {
    if (!ctx.tx || JSON.stringify(ctx.content) !== JSON.stringify(current ?? null)
      || ctx.state.changeSeq !== (capturedState?.changeSeq ?? 1)) throw new Error("This book changed while its retained copy was prepared. Both copies were kept.");
    // Preserve the losing local alternative before replacing any active reference.
    if (ctx.content || ctx.metadata || ink.length || Object.keys(children).length) {
      const retained: RecoveryCopy = { id: `restore-alternative:${newBookToken()}`, type: "conflict", ...{ kind: owner.kind, bookId: owner.id },
        provenance: { source: "explicit-recovery-restore", recoveryId: id },
        content: { metadata: ctx.metadata, payload: ctx.content, children, ink } };
      ctx.tx.objectStore(STORE_SYNC_RECOVERY).add(retained, retained.id);
    }
    const metadata: BookMeta = { ...record.meta, ...owner, deletedAt: undefined, purgedAt: undefined,
      deleteAcked: false, updatedAt: Date.now(), lastTouch: Date.now(), syncSeq: Math.max(Number(record.meta.syncSeq ?? 0), ctx.state.lifecycle?.seq ?? 0) + 1 };
    ctx.setMetadata(metadata);
    ctx.setContent(owner.kind === "problem" ? { ...metadata, ...record.payload } : record.payload);
    for (const [childId, child] of Object.entries(record.children ?? {})) ctx.tx.objectStore(STORE_CONTENT).put(child, `fnwb:${owner.id}:${childId}`);
    if (ctx.state.lifecycle?.action === "delete" || record.meta.deletedAt !== undefined || record.meta.purgedAt !== undefined) {
      ctx.markLifecycle("restore", Number(metadata.syncSeq), ctx.state.bootstrap ? null : ctx.state.appliedBookRev, ctx.state.lifecycle?.goneSeq ?? null);
    }
  });
  await notifyBookMetadataChanged(owner.kind, owner.id);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc-pad-hub", { detail: { ...owner, op: "reload" } }));
  return owner;
}

/** Export binary values without silently serializing them to empty JSON objects. */
export async function recoveryExportValue(value: unknown): Promise<unknown> {
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: [...new Uint8Array(value)] };
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  if (typeof Blob !== "undefined" && value instanceof Blob) return { type: "Blob", mimeType: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] };
  if (Array.isArray(value)) return Promise.all(value.map(recoveryExportValue));
  if (object(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await recoveryExportValue(item)])));
  return value;
}
