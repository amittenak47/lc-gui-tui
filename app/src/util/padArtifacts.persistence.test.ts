import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAnnotateDoc, listAnnotateDocs, restoreAnnotateDoc, restoreAnnotateFromTrash,
  saveAnnotateDoc, trashAnnotateDoc,
} from "./annotateStore";
import {
  getWhiteboardNotebook, listWhiteboardNotebooks, restoreWhiteboardNotebook,
  restoreWhiteboardFromTrash, saveWhiteboardNotebook, setWhiteboardNotebookLocked,
  trashWhiteboardNotebook,
} from "./whiteboardStore";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import type { BoardBlob } from "../canvas/BoardHandle";

const board: BoardBlob = { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
function catalog(parent: ArtifactParent): ArtifactCatalog {
  return {
    v: 1, parent, revision: "catalog-1", artifacts: [{
      id: "file-1", title: "Explanation.md", revision: "artifact-1",
      createdAt: 1, updatedAt: 2, associations: [{ kind: "thread", rootId: "turn-1" }],
      content: { kind: "markdown", documentId: "owned-1", sourceRevision: "source-1" },
    }],
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("artifact catalogs in parent content", () => {
  it("keeps document catalogs during ink/chat autosave without copying them into the index", async () => {
    const artifacts = catalog({ kind: "annotate", id: "a1" });
    const saved = await saveAnnotateDoc({
      id: "a1", name: "source.md", hash: "h1", source: "Source", board, artifacts,
    });
    await saveAnnotateDoc({ ...saved, artifacts: undefined, footnotes: [], agent: [{ id: "new" }] });
    expect((await getAnnotateDoc("a1"))?.artifacts).toEqual(artifacts);
    expect(listAnnotateDocs()[0]).toMatchObject({ artifactRevision: "catalog-1" });
    expect(listAnnotateDocs()[0]).not.toHaveProperty("artifacts");
  });

  it("keeps notebook catalogs during autosave, lock changes, trash and restore", async () => {
    const artifacts = catalog({ kind: "whiteboard", id: "w1" });
    await saveWhiteboardNotebook({ id: "w1", board, agent: [], pageCount: 1, artifacts });
    setWhiteboardNotebookLocked("w1", true);
    setWhiteboardNotebookLocked("w1", false);
    await saveWhiteboardNotebook({ id: "w1", board, agent: [], pageCount: 2 });
    expect((await getWhiteboardNotebook("w1"))?.artifacts).toEqual(artifacts);
    expect(listWhiteboardNotebooks()[0]).not.toHaveProperty("artifacts");
    await trashWhiteboardNotebook("w1");
    expect((await restoreWhiteboardFromTrash("w1"))?.artifacts).toEqual(artifacts);
  });

  it("retains document catalogs across trash and legacy restore omission", async () => {
    const artifacts = catalog({ kind: "annotate", id: "a1" });
    const saved = await saveAnnotateDoc({ id: "a1", name: "note.md", hash: "h", source: "", board, artifacts });
    await trashAnnotateDoc("a1");
    expect((await restoreAnnotateFromTrash("a1"))?.artifacts).toEqual(artifacts);
    await restoreAnnotateDoc({ ...saved, artifacts: undefined });
    expect((await getAnnotateDoc("a1"))?.artifacts).toEqual(artifacts);
  });

  it("does not erase a catalog when an older notebook caller restores without the field", async () => {
    const artifacts = catalog({ kind: "whiteboard", id: "w1" });
    const saved = await saveWhiteboardNotebook({ id: "w1", board, agent: [], pageCount: 1, artifacts });
    await restoreWhiteboardNotebook({ ...saved, artifacts: undefined });
    expect((await getWhiteboardNotebook("w1"))?.artifacts).toEqual(artifacts);
  });

  it("rejects the wrong parent before overwriting either content or index", async () => {
    const artifacts = catalog({ kind: "annotate", id: "a1" });
    const saved = await saveAnnotateDoc({ id: "a1", name: "note.md", hash: "h", source: "old", board, artifacts });
    await expect(saveAnnotateDoc({ ...saved, source: "changed", artifacts: catalog({ kind: "annotate", id: "a2" }) }))
      .rejects.toThrow("different parent");
    expect((await getAnnotateDoc("a1"))?.source).toBe("old");
    await expect(saveWhiteboardNotebook({ id: "w1", title: "Bad", board, pageCount: 1, artifacts }))
      .rejects.toThrow("different parent");
    expect(listWhiteboardNotebooks()).toEqual([]);
  });

  it("retains deletion records rather than interpreting an empty active set as no catalog", async () => {
    const artifacts = catalog({ kind: "whiteboard", id: "w1" });
    artifacts.artifacts[0]!.deletedAt = 2;
    await saveWhiteboardNotebook({ id: "w1", board, pageCount: 1, artifacts });
    await saveWhiteboardNotebook({ id: "w1", board, pageCount: 1, agent: [] });
    expect((await getWhiteboardNotebook("w1"))?.artifacts).toEqual(artifacts);
  });
});
