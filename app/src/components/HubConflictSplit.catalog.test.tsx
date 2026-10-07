/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { HubConflictSplit } from "./HubConflictSplit";
import type { HubPadConflict } from "../util/hubConflictStash";
import type { ArtifactCatalog } from "../util/padArtifacts";
vi.mock("./ConflictPagePreview", () => ({ ConflictPagePreview: () => null }));
const parent = { kind: "whiteboard" as const, id: "catalog-test" };
const catalog = (revision: string): ArtifactCatalog => ({ v: 1, parent, revision, artifacts: [{
  id: "note", title: "Attachment note.md", revision, createdAt: 1, updatedAt: 2,
  associations: [{ kind: "file" }], content: { kind: "markdown", documentId: "doc", sourceRevision: revision },
}] });
const body = (revision: string) => ({ id: parent.id, title: "Test", updated_at: 1, page_count: 1,
  board: { v: 1 as const, elements: [], appState: { zoom: 1, scrollX: 0, scrollY: 0 } }, agent: [], artifacts: catalog(revision) });
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
function mount(extra: Partial<HubPadConflict> = {}) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onResolve = vi.fn();
  act(() => root.render(<HubConflictSplit conflict={{ ...parent, stage: "pad", detail: "Conflict", local: body("local"), server: body("remote"), serverInk: [], ...extra }} onResolve={onResolve} />));
  return onResolve;
}
function button(label: string) { return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; }
function resolve() { return document.querySelector<HTMLButtonElement>(".lc-hub-conflict-resolve")!; }

it.each(["Local", "Tablet"])("requires and submits the %s attachment choice without any ink rows", side => {
  const done = mount();
  expect([...document.querySelectorAll(".lc-hub-conflict-dock-count")].map(n => n.textContent)).toEqual(["1", "1"]);
  expect(document.body.textContent).toContain("Attachment note.md");
  expect(resolve().disabled).toBe(true);
  expect(button(`Keep every ${side} copy`).disabled).toBe(false);
  act(() => button(`Keep every ${side} copy`).click());
  act(() => resolve().click());
  const selected = side === "Local" ? "local" : "server";
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ pick: selected, artifacts: selected }));
});

it("keeps both catalogs with conflict-copy preservation and refuses dropping both", () => {
  const done = mount();
  act(() => button("Keep Local attachments").click());
  act(() => button("Keep Tablet attachments").click());
  act(() => resolve().click());
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ pick: "merged", artifacts: "local" }));
  act(() => button("Drop every Local change").click());
  act(() => button("Drop every Tablet change").click());
  expect(resolve().disabled).toBe(true);
  expect(document.body.textContent).toContain("Keep at least one attachment version");
});

it("hides matching attachment rows with Differences only even when catalog revisions differ", () => {
  const remote = body("local"); remote.artifacts.revision = "different-catalog-revision";
  mount({ server: remote });
  expect(document.querySelector('[data-row-key="@artifact-catalog"]')).toBeNull();
  expect([...document.querySelectorAll(".lc-hub-conflict-dock-count")].map(n => n.textContent)).toEqual(["0", "0"]);
});

it("submits a server attachment preference independently of locally kept handwriting", () => {
  const done = mount({ localInkPageIds: [1], hubInkPageIds: [1], localInkStamps: [{ pageId: 1, updatedAt: 1 }], hubInkStamps: [{ pageId: 1, updatedAt: 2 }] });
  act(() => button("Keep Local handwriting").click());
  act(() => button("Keep Tablet attachments").click());
  act(() => resolve().click());
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ pick: "merged", artifacts: "server", inkPages: [{ pageId: 1, choice: "local" }] }));
});
