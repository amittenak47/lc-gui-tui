import { createArtifact, readArtifact, saveArtifact, mutateArtifacts, readArtifactCatalog } from "../src/util/artifactRepository";
import { putProblemBoard, getProblemBoard } from "../src/util/problemBoardStore";
import { applyHubProblem } from "../src/util/padSync";
import { resolveProblemArtifactConflict } from "../src/util/problemArtifactConflict";
import { uploadArtifactAssets } from "../src/util/artifactAssetSync";
import { artifactAssetKey } from "../src/util/artifactAssets";
import { collectArtifactCache, ARTIFACT_CACHE_RETENTION_MS } from "../src/util/artifactCacheGc";
import { saveWhiteboardNotebook, getWhiteboardNotebook } from "../src/util/whiteboardStore";
import { captureArtifactSnapshot } from "../src/util/artifactSnapshot";
import { restoreArtifactSnapshot } from "../src/util/artifactSnapshotRestore";
import { putArtifactDraft, getArtifactDraft } from "../src/util/artifactDrafts";
import { run, STORE_CONTENT, STORE_INK_PAGES } from "../src/util/idb";
import { inkPageKey, whiteboardDocKey } from "../src/util/inkPageStore";
import { bytesToB64 } from "../src/api/nativeHttp";
import { encodeInkOps, packEncodedInk } from "../src/canvas/inkCodec";
import type { ArtifactRef } from "../src/util/padArtifacts";
import { saveAnnotateDoc, getAnnotateDoc } from "../src/util/annotateStore";
import { captureLibraryReference, referenceSnapshot } from "../src/util/artifactReferenceSources";

const board = () => ({ v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } });
const document = (source: string) => ({ kind: "markdown" as const, value: { owned: true as const, docType: "markdown" as const,
  name: "Note.md", source, board: board(), footnotes: [], agent: [], ink: new Map() } });
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const reject = async (fn: () => Promise<unknown>, label: string) => {
  let failed = false; try { await fn(); } catch { failed = true; } assert(failed, label);
};
const owner = { kind: "problem" as const, id: "phase3-test/1" };
const handwriting = () => encodeInkOps([{ kind: "draw", color: "#111111", baseWidth: 2, maxFullness: 0.8,
  pressureClip: 0.6, pressureSensitive: true, points: [{ x: 10, y: 20, pressure: 0.5 }, { x: 30, y: 40, pressure: 0.6 }] }]);
let ref: ArtifactRef;
async function transfer() {
  const row = (await getProblemBoard(owner.id))!;
  const assets: any[] = [];
  await uploadArtifactAssets({ putArtifactAsset: async asset => { assets.push(asset); return asset; }, getArtifactAsset: async () => null }, row.artifacts);
  return { row: { id: row.id, dataset: row.dataset, task_id: row.taskId, board: row.board, agent: row.agent ?? [], artifacts: row.artifacts,
    updated_at: row.updatedAt, sync_seq: row.syncSeq ?? 0 }, assets, ref };
}
const transport = (packet: Awaited<ReturnType<typeof transfer>>) => ({
  getArtifactAsset: async (locator: any) => packet.assets.find(asset => artifactAssetKey(asset) === artifactAssetKey(locator)) ?? null,
  putArtifactAsset: async (asset: any) => asset,
});
const api = {
  async picker() { (await import("./artifact-picker-review")).showPicker(); return true; },
  async seed() {
    await putProblemBoard({ id: owner.id, dataset: "phase3-test", taskId: "1", updatedAt: 1, board: board(), agent: [] });
    ref = await createArtifact(owner, "Shared note", [{ kind: "file" }], document("initial"));
    await createArtifact(owner, "Sketch", [{ kind: "file" }], { kind: "whiteboard", value: {
      board: { ...board(), inkPages: { v: 1, pageIds: [2] } }, pageCount: 2, programs: [], ink: new Map([[2, handwriting()]]),
    } });
    const code = document("print(1)");
    await createArtifact(owner, "Code.py", [{ kind: "file" }], { kind: "code", value: { ...code.value, docType: "code", name: "Code.py" } });
    const original = await saveAnnotateDoc({ name: "Imported reading.md", hash: "reading", owned: false, source: "Read-only imported source",
      docType: "markdown", board: board() });
    const captured = await captureLibraryReference(original.id, 1);
    const capturedRef = await createArtifact(owner, captured.title, [], { kind: captured.kind, value: referenceSnapshot(captured, board()) });
    const saved = await readArtifact(capturedRef);
    await reject(() => saveArtifact(capturedRef, saved.item.revision, "Overwrite", document("changed")), "source capture must remain read-only");
    const copy = document(captured.text);
    const copiedRef = await createArtifact(owner, "Editable copy", [], copy);
    const copied = await readArtifact(copiedRef);
    await saveArtifact(copiedRef, copied.item.revision, "Editable copy", document("edited independently"));
    assert(JSON.stringify(await getAnnotateDoc(original.id)) === JSON.stringify(original), "capture and copy must not modify source library file");
    return transfer();
  },
  async receive(packet: Awaited<ReturnType<typeof transfer>>) {
    ref = packet.ref;
    await applyHubProblem(packet.row, { emitReload: false, client: transport(packet) as never });
    for (const item of packet.row.artifacts!.artifacts) {
      if (item.deletedAt !== undefined) continue;
      const opened = await readArtifact({ parent: owner, artifactId: item.id, kind: item.content.kind });
      if (opened.snapshot.kind === "whiteboard") assert(opened.snapshot.value.ink.get(2)?.ops.length === 1, "multipage handwriting survives transfer");
      if (opened.snapshot.kind === "code") assert(opened.snapshot.value.source === "print(1)", "owned code reopens");
      if (opened.snapshot.kind !== "whiteboard" && opened.snapshot.value.sourceReference) {
        assert(opened.snapshot.value.source === "Read-only imported source", "reference capture transfers independently of source library");
        assert(opened.snapshot.value.sourceReference.locator === "Lines 1–1", "source provenance reopens");
      }
    }
    return (await readArtifact(ref)).snapshot;
  },
  async edit(source: string) {
    const { item } = await readArtifact(ref);
    await saveArtifact(ref, item.revision, item.title, document(source));
    return transfer();
  },
  async conflict(packet: Awaited<ReturnType<typeof transfer>>) {
    const local = (await getProblemBoard(owner.id))!;
    await resolveProblemArtifactConflict(transport(packet) as never, { local, server: packet.row }, "local");
    const catalog = (await readArtifactCatalog(owner))!;
    const sources = [];
    for (const item of catalog.artifacts) {
      const value = await readArtifact({ parent: owner, artifactId: item.id, kind: item.content.kind });
      if (value.snapshot.kind !== "whiteboard") sources.push(value.snapshot.value.source);
    }
    assert(sources.includes("device A") && sources.includes("device B"), "both authored sources survive conflict");
    return transfer();
  },
  async missing(packet: Awaited<ReturnType<typeof transfer>>) {
    const before = await getProblemBoard(owner.id);
    await reject(() => api.receive({ ...packet, assets: [] }), "missing dependencies must reject");
    assert(JSON.stringify(await getProblemBoard(owner.id)) === JSON.stringify(before), "failed receive preserves parent");
    return true;
  },
  async draft() {
    const saved = await readArtifact(ref);
    const snapshot = document("recover after reload");
    snapshot.value.ink.set(1, handwriting());
    await putArtifactDraft(ref, { v: 1, item: saved.item, title: "Unsent draft", snapshot });
    return ref;
  },
  async recover(savedRef: ArtifactRef) {
    ref = savedRef;
    const draft = await getArtifactDraft(ref);
    assert(draft?.snapshot.kind === "markdown" && draft.snapshot.value.source === "recover after reload", "draft survives browser reload");
    assert(draft?.snapshot.value.ink.get(1)?.ops.length === 1, "packed draft handwriting survives process crash");
    return true;
  },
  async lifecycle() {
    const initial = await readArtifact(ref);
    const deleted = await mutateArtifacts(owner, initial.catalog.revision, { type: "delete", id: ref.artifactId, expectedRevision: initial.item.revision });
    await reject(() => readArtifact(ref), "deleted reference must stay unavailable");
    await mutateArtifacts(owner, deleted.revision, { type: "restore", id: ref.artifactId, expectedRevision: deleted.artifacts.find(item => item.id === ref.artifactId)!.revision });
    assert((await readArtifact(ref)).item.restoredFrom !== undefined, "explicit restoration ancestry");
    return true;
  },
  async snapshots() {
    const parent = { kind: "whiteboard" as const, id: "phase3-snapshot-test" };
    await saveWhiteboardNotebook({ id: parent.id, title: "Snapshot test", pageCount: 1, board: board(), agent: [] });
    const attachment = await createArtifact(parent, "Note", [{ kind: "file" }], document("snapshot source"));
    const original = await readArtifact(attachment);
    const bundle = (await captureArtifactSnapshot(original.catalog))!;
    await saveArtifact(attachment, original.item.revision, "Note", document("live source"));
    const docKey = whiteboardDocKey(parent.id);
    const gz = packEncodedInk({ v: 2, ops: [] });
    await run(STORE_INK_PAGES, "readwrite", store => store.put({ v: 1, docKey, pageId: 1, gz, updatedAt: 4, dirty: true }, inkPageKey(docKey, 1)));
    const before = await run(STORE_CONTENT, "readonly", store => store.get(parent.id));
    const beforeInk = await run(STORE_INK_PAGES, "readonly", store => store.get(inkPageKey(docKey, 1)));
    const snapshot = { board: { ...board(), inkPages: { v: 1 as const, pageIds: [2] } }, ink: [{ pageId: 2, updatedAt: 3, gz: bytesToB64(gz) }], agent: ["snapshot chat"] };
    const originalPut = IDBObjectStore.prototype.put;
    let injected = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === STORE_INK_PAGES) { injected = true; throw new DOMException("Injected quota failure", "QuotaExceededError"); }
      return originalPut.apply(this, args);
    };
    try { await reject(() => restoreArtifactSnapshot(parent, snapshot, bundle), "restore must reject transaction failure"); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    assert(injected, "failure was injected inside the content/ink transaction");
    assert(JSON.stringify(await run(STORE_CONTENT, "readonly", s => s.get(parent.id))) === JSON.stringify(before), "catalog/scene rollback on abort");
    assert(JSON.stringify(await run(STORE_INK_PAGES, "readonly", s => s.get(inkPageKey(docKey, 1)))) === JSON.stringify(beforeInk), "ink rollback on abort");
    await reject(() => restoreArtifactSnapshot(parent, { ...snapshot, ink: [] }, bundle), "missing snapshot ink must reject");
    await reject(() => restoreArtifactSnapshot(parent, { ...snapshot, ink: [{ pageId: 2, updatedAt: 3, gz: "AA==" }] }, bundle), "damaged snapshot ink must reject");
    let raced = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (!raced && this.name === STORE_CONTENT && String(args[1]).startsWith("artifact-asset:")) {
        raced = true;
        originalPut.call(this, { ...before, agent: ["new local edit during restore"] }, parent.id);
      }
      return originalPut.apply(this, args);
    };
    try { await reject(() => restoreArtifactSnapshot(parent, snapshot, bundle), "concurrent parent edit must reject restore"); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    assert(raced && (await getWhiteboardNotebook(parent.id))?.agent[0] === "new local edit during restore", "concurrent edit survives failed restore");
    await restoreArtifactSnapshot(parent, snapshot, bundle);
    const reopened = await readArtifact(attachment);
    assert(reopened.snapshot.kind === "markdown" && reopened.snapshot.value.source === "snapshot source", "snapshot source reopens");
    assert((await getWhiteboardNotebook(parent.id))?.agent[0] === "snapshot chat", "snapshot transcript commits");
    assert(!await run(STORE_INK_PAGES, "readonly", s => s.get(inkPageKey(docKey, 1))), "old ink removed only on success");
    assert(await run(STORE_INK_PAGES, "readonly", s => s.get(inkPageKey(docKey, 2))), "snapshot ink committed");
    return true;
  },
  async gc() {
    const saved = await readArtifact(ref);
    const packet = await transfer();
    const liveAsset = packet.assets[0];
    const obsolete = { ...liveAsset, dependency: { ...liveAsset.dependency, revision: "obsolete" } };
    const unacked = { ...liveAsset, dependency: { ...liveAsset.dependency, revision: "unacked" } };
    const old = Date.now() - ARTIFACT_CACHE_RETENTION_MS - 1000;
    for (const asset of [liveAsset, obsolete, unacked]) await run(STORE_CONTENT, "readwrite", store => store.put({ ...asset,
      lastUsedAt: old, ...(asset === unacked ? {} : { transferredAt: old }) }, artifactAssetKey(asset)));
    const removed = await collectArtifactCache();
    assert(removed === 1, "only acknowledged obsolete cache asset is removed");
    assert(await run(STORE_CONTENT, "readonly", s => s.get(artifactAssetKey(liveAsset))), "live revision pinned");
    assert(await run(STORE_CONTENT, "readonly", s => s.get(artifactAssetKey(unacked))), "unacknowledged authored content retained");
    assert((await readArtifact(ref)).item.revision === saved.item.revision, "GC preserves editable artifact");
    return true;
  },
  async keepBothCanvases() {
    const id = "phase3-test/keep-both";
    const local = { id, dataset: "phase3-test", taskId: "keep-both", updatedAt: 1, board: { ...board(), inkC: handwriting() }, agent: [] };
    await putProblemBoard(local);
    const remoteBoard = { ...board(), elements: [{ id: "remote", type: "text", text: "remote drawing", x: 100, y: 5000, width: 300, height: 40 }], inkC: handwriting() };
    const result = await resolveProblemArtifactConflict({} as never, { local, server: { id, dataset: local.dataset, task_id: local.taskId,
      updated_at: 2, board: remoteBoard, agent: [] } }, "merged");
    assert(JSON.stringify(result.board) === JSON.stringify(local.board), "keep both retains local canvas");
    const item = result.artifacts!.artifacts[0];
    const copy = await readArtifact({ parent: { kind: "problem", id }, artifactId: item.id, kind: "whiteboard" });
    assert(copy.snapshot.kind === "whiteboard" && copy.snapshot.value.ink.get(0)?.ops.length === 1, "other canvas keeps handwriting");
    assert((copy.snapshot.value.board.elements[0] as any).customData.lcRegion === "pad-0", "copy has a usable notebook page");
    return true;
  },
};
(window as any).artifactChecks = api;
