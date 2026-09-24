import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editParentContentArtifacts, getContent, putParentContent, resetContentRepairForTests } from "./contentStore";
import { editAnnotateArtifacts, getAnnotateDoc, getAnnotateDocMeta, saveAnnotateDoc } from "./annotateStore";
import { editWhiteboardArtifacts, getWhiteboardNotebook, listWhiteboardNotebooks, saveWhiteboardNotebook } from "./whiteboardStore";
import { editArtifactCatalog, type ArtifactCatalogEdit } from "./artifactCatalogEdits";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import type { BoardBlob } from "../canvas/BoardHandle";

const state = vi.hoisted(() => ({
  db: new Map<string, any>(), ls: new Map<string, string>(),
  beforeWrite: undefined as (() => void) | undefined,
  preflight: undefined as (() => void) | undefined,
  failDb: false, failIndex: false,
}));
vi.mock("./artifactAssetSync", () => ({ downloadArtifactAssets: async () => { state.preflight?.(); } }));
vi.mock("./idb", async (original) => ({
  ...await original<typeof import("./idb")>(),
  run: async (_name: string, _mode: string, work: (store: any) => any) => {
    if (state.failDb) throw new Error("database unavailable");
    return work({ get: (id: string) => ({ result: structuredClone(state.db.get(id)) }),
      put: (row: unknown, id: string) => { state.db.set(id, structuredClone(row)); return {}; } }).result;
  },
  withStore: async (_name: string, _mode: string, work: (store: any) => void) => {
    if (state.failDb) throw new Error("database unavailable");
    const hook = state.beforeWrite; state.beforeWrite = undefined; hook?.();
    const reads: Array<{ result: any; onsuccess?: () => void }> = [];
    const writes = new Map<string, unknown>();
    let aborted = false;
    work({ transaction: { abort: () => { aborted = true; } },
      get: (id: string) => { const request = { result: structuredClone(state.db.get(id)), onsuccess: undefined }; reads.push(request); return request; },
      put: (row: unknown, id: string) => writes.set(id, structuredClone(row)),
    });
    for (const request of reads) request.onsuccess?.();
    if (aborted) throw new Error("transaction aborted");
    for (const [id, row] of writes) state.db.set(id, row);
  },
}));
const board: BoardBlob = { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const parent: ArtifactParent = { kind: "annotate", id: "a1" };
const create: ArtifactCatalogEdit = { type: "create", id: "file1", title: "Note.md", associations: [{ kind: "file" }],
  content: { kind: "markdown", documentId: "owned1", sourceRevision: "s1" } };
const catalog = (owner = parent): ArtifactCatalog => editArtifactCatalog(undefined, owner, null, create, 1);
beforeEach(() => {
  state.db.clear(); state.ls.clear(); state.beforeWrite = undefined; state.preflight = undefined;
  state.failDb = false; state.failIndex = false;
  resetContentRepairForTests();
  vi.stubGlobal("localStorage", {
    get length() { return state.ls.size; }, key: (i: number) => [...state.ls.keys()][i] ?? null,
    getItem: (key: string) => state.ls.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.failIndex && key.includes("index")) throw new Error("index unavailable");
      state.ls.set(key, value);
    }, removeItem: (key: string) => state.ls.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("transactional parent attachment preservation", () => {
  it("removes tombstoned thread links on inactive documents and rejects their resurrection by a stale save", async () => {
    const note = {id:"mark",threads:[{rootId:"q"},{rootId:"unloaded"}],threadRootId:"q",bands:[{left:91}],future:{kept:true}};
    state.db.set("a1",{board,footnotes:[note],agent:[{id:"q"}]});
    await putParentContent(parent,{artifacts:undefined,agent:[{id:"q",deletedAt:12}]},{agentOnly:true});
    expect(state.db.get("a1").footnotes[0]).toEqual({...note,threads:[{rootId:"unloaded"}],threadRootId:"unloaded"});
    await putParentContent(parent,{artifacts:undefined,board,footnotes:[note],agent:[{id:"q"}]});
    expect(state.db.get("a1").footnotes[0]).toEqual({...note,threads:[{rootId:"unloaded"}],threadRootId:"unloaded"});
  });
  it("keeps sync tombstones through a stale local save and merges acknowledgements without replacing newer ink", async () => {
    state.db.set("a1", { board, source: "newer source", agent: [{ id: "q", content: "question", deletedAt: 8 }] });
    await putParentContent(parent, { artifacts: undefined, agent: [{ id: "q", content: "question" }, { id: "remote" }] }, { agentOnly: true });
    expect(state.db.get("a1")).toMatchObject({ source: "newer source", board,
      agent: [expect.objectContaining({ id: "q", deletedAt: 8 }), { id: "remote" }] });
    await putParentContent(parent, { artifacts: undefined, board, agent: [{ id: "q", content: "question" }] });
    expect(state.db.get("a1").agent).toEqual([expect.objectContaining({ id: "q", deletedAt: 8 }), { id: "remote" }]);
  });
  it("preserves a catalog added after an ordinary save began", async () => {
    const artifacts = catalog();
    state.beforeWrite = () => state.db.set("a1", { board, source: "old", artifacts });
    const saved = await putParentContent(parent, { board, source: "new", artifacts: undefined });
    expect(saved).toEqual({ board, source: "new", artifacts });
  });

  it("never spills a rejected catalog edit over the valid stored copy", async () => {
    const artifacts = catalog();
    state.db.set("a1", { board, artifacts });
    await expect(putParentContent(parent, { board, artifacts: { ...artifacts, artifacts: [] } })).rejects.toThrow("revision");
    expect(state.db.get("a1").artifacts).toEqual(artifacts);
    expect(state.ls.has("whiteboard.content.v1.a1")).toBe(false);
  });

  it("rejects ordinary stale saves even when both catalog revisions are structurally valid", async () => {
    const before = catalog();
    const after = editArtifactCatalog(before, parent, before.revision, {
      type: "update", id: "file1", expectedRevision: before.artifacts[0].revision, patch: { title: "Newer.md" },
    }, 2);
    state.db.set("a1", { board, artifacts: after });
    await expect(putParentContent(parent, { board, artifacts: before })).rejects.toThrow("changed since");
    expect(state.db.get("a1").artifacts).toEqual(after);
  });

  it("rechecks the base after preflight and preserves newer source/ink during catalog-only edits", async () => {
    state.db.set("a1", { board, source: "old" });
    state.preflight = () => state.db.set("a1", { board, source: "new", agent: ["new message"] });
    const next = await editParentContentArtifacts(parent, null, create, () => {});
    expect(state.db.get("a1")).toMatchObject({ source: "new", agent: ["new message"], artifacts: next });
    state.preflight = () => state.db.set("a1", { ...state.db.get("a1"), artifacts: { ...next, revision: "concurrent" } });
    await expect(editParentContentArtifacts(parent, next.revision, { type: "detach", association: { kind: "file" } }, () => {}))
      .rejects.toThrow("changed since");
    expect(state.db.get("a1").artifacts.revision).toBe("concurrent");
  });

  it("retains legacy fallback but refuses to pretend guarded edits are atomic there", async () => {
    state.failDb = true;
    const artifacts = catalog();
    await putParentContent(parent, { board, artifacts });
    await putParentContent(parent, { board, artifacts: undefined });
    expect(await getContent("a1")).toEqual({ board, artifacts });
    await expect(editParentContentArtifacts(parent, artifacts.revision, { type: "detach", association: { kind: "file" } }, () => {}))
      .rejects.toThrow("Repair local storage");
  });
});

describe("document/notebook artifact integration", () => {
  it("commits document and notebook catalogs and retains them through ordinary saves", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Main.md", hash: "h1", source: "text", board, footnotes: [], agent: [] });
    const docCatalog = await editAnnotateArtifacts("a1", null, create);
    await saveAnnotateDoc({ id: "a1", name: "Main.md", hash: "h1", source: "changed", board, footnotes: [], agent: [] });
    expect((await getAnnotateDoc("a1"))?.artifacts).toEqual(docCatalog);
    expect(getAnnotateDocMeta("a1")?.artifactRevision).toBe(docCatalog.revision);
    await saveWhiteboardNotebook({ id: "w1", board, pageCount: 1, agent: [] });
    const wbCatalog = await editWhiteboardArtifacts("w1", null, create);
    await saveWhiteboardNotebook({ id: "w1", board, pageCount: 2, agent: [] });
    expect((await getWhiteboardNotebook("w1"))?.artifacts).toEqual(wbCatalog);
    expect(listWhiteboardNotebooks()[0].artifactRevision).toBe(wbCatalog.revision);
  });

  it("does not change the library index when catalog validation fails", async () => {
    const artifacts = catalog();
    const saved = await saveAnnotateDoc({ id: "a1", name: "Main.md", hash: "h1", source: "text", board, artifacts });
    const before = getAnnotateDocMeta("a1");
    await expect(saveAnnotateDoc({ ...saved, name: "Lost.md", artifacts: { ...artifacts, artifacts: [] } })).rejects.toThrow();
    expect(getAnnotateDocMeta("a1")).toEqual(before);
    expect((await getAnnotateDoc("a1"))?.name).toBe("Main.md");
  });

  it("repairs interrupted content-to-index catalog updates on the next read", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Main.md", hash: "h1", source: "text", board });
    const before = getAnnotateDocMeta("a1")!;
    state.failIndex = true;
    await expect(editAnnotateArtifacts("a1", null, create)).rejects.toThrow("index unavailable");
    expect(getAnnotateDocMeta("a1")?.artifactRevision).toBeUndefined();
    state.failIndex = false;
    const recovered = await getAnnotateDoc("a1");
    expect(getAnnotateDocMeta("a1")?.artifactRevision).toBe(recovered?.artifacts?.revision);
    expect(recovered!.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it("does not publish an attachment after the parent disappears during preflight", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Main.md", hash: "h1", source: "text", board });
    state.preflight = () => state.ls.set("whiteboard.annotate.index.v1", "[]");
    await expect(editAnnotateArtifacts("a1", null, create)).rejects.toThrow("removed");
    expect(state.db.get("a1").artifacts).toBeUndefined();
  });
});
