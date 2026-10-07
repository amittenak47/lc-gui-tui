/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BookStateDto, CommitRequestDto, CommitResultDto, LcClient } from "../api/client";
import { syncBook } from "./bookSync";
import { captureBook } from "./bookSnapshot";
import { saveWhiteboardNotebook, renameWhiteboardNotebook } from "./whiteboardStore";
import { createArtifact, readArtifact, saveArtifact } from "./artifactRepository";
import { stageOwnedDocumentSnapshot } from "./artifactDocuments";
import { artifactProposalSnapshot } from "./agentArtifacts";
import { closeDbForTests } from "./idb";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { recordHash } from "./syncContent";
import { getArtifactAsset, putArtifactAsset } from "./artifactAssetStore";
import type { ArtifactCatalog } from "./padArtifacts";
const parent = { kind: "whiteboard" as const, id: "catalog-choices" };
const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
beforeEach(async () => {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  localStorage.clear();
  vi.stubGlobal("navigator", { locks: { request: (_key: string, options: unknown, fn?: () => Promise<unknown>) => typeof options === "function" ? options() : fn!() } });
});
afterEach(async () => { await closeDbForTests(); vi.unstubAllGlobals(); });

it.each(["local", "server"] as const)("keeps %s attachments independently of the record and preserves both authored sources atomically", async preference => {
  let head: BookStateDto = { ...parent, state: "absent", book_rev: 0, record_rev: 0, record_hash: null, record: null, pages: [], gone_seq: null };
  const api = {
    getBookState: vi.fn(async () => structuredClone(head)),
    checkBookHead: vi.fn(async () => ({ unchanged: true, book_rev: head.book_rev })),
    getArtifactAsset: vi.fn(getArtifactAsset), putArtifactAsset: vi.fn(async asset => { await putArtifactAsset(asset); return asset; }),
    commitPad: vi.fn(async (body: CommitRequestDto) => {
      const record = body.record?.value ?? head.record;
      head = { ...head, state: "live", record, record_hash: record ? await recordHash(record) : null, record_rev: head.record_rev + 1, book_rev: head.book_rev + 1 };
      return { status: "committed", upload_id: body.upload_id, record_rev: head.record_rev, page_revs: [], book: structuredClone(head) } as CommitResultDto;
    }),
  } as unknown as LcClient;
  await saveWhiteboardNotebook({ id: parent.id, title: "Original book", pageCount: 1, board });
  const ref = await createArtifact(parent, "Owned note", [{ kind: "file" }], artifactProposalSnapshot({ kind: "markdown", title: "Owned note", source: "common base" }, false));
  const options = { timeoutMs: 3000, wait: async () => {} };
  expect((await syncBook(api, parent.kind, parent.id, undefined, options)).status).toBe("synced");
  const common = await readArtifact(ref);
  const remoteContent = await stageOwnedDocumentSnapshot(parent, common.item.content.kind === "whiteboard" ? "unused" : common.item.content.documentId,
    { ...common.snapshot.value, source: "remote authored source" } as Parameters<typeof stageOwnedDocumentSnapshot>[2]);
  const remoteCatalog = structuredClone(head.record!.artifacts) as ArtifactCatalog;
  remoteCatalog.revision = "remote-catalog";
  remoteCatalog.artifacts[0] = { ...remoteCatalog.artifacts[0], revision: "remote-item", updatedAt: common.item.updatedAt + 1, content: remoteContent };
  head = { ...head, record: { ...head.record!, title: "Remote book", artifacts: remoteCatalog }, record_rev: head.record_rev + 1, book_rev: head.book_rev + 1 };
  head.record_hash = await recordHash(head.record);
  await saveArtifact(ref, common.item.revision, common.item.title, { ...common.snapshot, value: { ...common.snapshot.value, source: "local authored source" } } as Parameters<typeof saveArtifact>[3]);
  await renameWhiteboardNotebook(parent.id, "Local book");
  vi.mocked(api.commitPad).mockClear();
  const recordChoice = preference === "server" ? "local" : "server";
  const result = await syncBook(api, parent.kind, parent.id, undefined, { ...options, manual: true, requestChoice: async (_conflict, lifecycle) => {
    lifecycle.onMounted(); return { record: recordChoice, artifacts: preference, pages: [] };
  } });
  expect(result.status).toBe("synced");
  expect(api.commitPad).toHaveBeenCalledTimes(1);
  expect(head.record!.title).toBe(recordChoice === "local" ? "Local book" : "Remote book");
  const chosen = await readArtifact(ref);
  if (chosen.snapshot.kind === "whiteboard") throw new Error("Expected a document attachment");
  expect(chosen.snapshot.value.source).toBe(`${preference === "local" ? "local" : "remote"} authored source`);
  const catalog = (await captureBook(parent)).record!.artifacts as ArtifactCatalog;
  expect(catalog).toEqual(head.record!.artifacts);
  expect(catalog.artifacts).toHaveLength(2);
  const alternative = await readArtifact({ ...ref, artifactId: catalog.artifacts.find(item => item.id !== ref.artifactId)!.id });
  if (alternative.snapshot.kind === "whiteboard") throw new Error("Expected a document attachment copy");
  expect(alternative.snapshot.value.source).toBe(`${preference === "local" ? "remote" : "local"} authored source`);
});
