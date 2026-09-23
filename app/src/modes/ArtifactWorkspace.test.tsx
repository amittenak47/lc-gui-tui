/** @vitest-environment jsdom */
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ArtifactWorkspace } from "./ArtifactWorkspace";

const state = vi.hoisted(() => ({
  region: "", fits: [] as Array<[string, string]>, order: [] as string[],
  pages: new Map([[0, { v: 2, ops: [] }], [1, { v: 2, ops: [] }]]),
  save: vi.fn(), draft: vi.fn(), removeDraft: vi.fn(),
  shell: { themeId: "dark", readingSize: "M", setChrome: vi.fn(), patchTab: vi.fn(), setWorkspaceApi: vi.fn(), openWorkspace: vi.fn(), client: {} },
}));
const fixture = vi.hoisted(() => ({
  item: { id: "board", title: "Two pages", revision: "saved", content: { kind: "whiteboard" } },
  snapshot: { kind: "whiteboard", value: { pageCount: 2, programs: [], ink: new Map(), board: { elements: [], appState: {} } } },
}));
vi.mock("../shellContext", () => ({ useShell: () => state.shell, NO_CHROME: {} }));
vi.mock("../util/artifactRepository", () => ({ readArtifact: async () => fixture, saveArtifact: (...args: unknown[]) => state.save(...args), createArtifact: vi.fn() }));
vi.mock("../util/artifactDrafts", () => ({ getArtifactDraft: async () => null, putArtifactDraft: (...args: unknown[]) => state.draft(...args), deleteArtifactDraft: () => state.removeDraft() }));
vi.mock("../util/artifactSync", () => ({ syncArtifactParent: async () => false }));
vi.mock("../canvas/boardChunk", () => ({ loadBoardComponent: async () => MockBoard }));
const MockBoard = forwardRef(function MockBoard(props: { mobileRegion: string; onChange(): void }, ref) {
  state.region = props.mobileRegion;
  useImperativeHandle(ref, () => ({
    restoreBoard: () => { state.order.push("restore"); }, waitForTemplate: async () => { state.order.push("template"); },
    primeInkSnap: async () => { state.order.push("prime"); }, ingestInkPages: () => { state.order.push("ingest"); },
    fitRegion: (region: string) => state.fits.push([region, state.region]),
    isInking: () => false, saveBoard: () => ({ v: 1, elements: [], appState: {} }),
    getElements: () => [], snapshotInkPages: () => state.pages,
  }), []);
  return <button onClick={props.onChange}>Draw</button>;
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.order = []; state.fits = []; state.save.mockReset(); state.draft.mockReset(); state.removeDraft.mockReset();
  state.save.mockResolvedValue(fixture.item);
});
afterEach(() => { vi.unstubAllGlobals(); document.body.textContent = ""; });
async function mount() {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<ArtifactWorkspace active showing tab={{ id: "test", kind: "whiteboard", title: "Two pages", notebookId: null, dirty: false, lastActive: 0,
    artifact: { parent: { kind: "whiteboard", id: "parent" }, artifactId: "board", kind: "whiteboard" } }} />));
  const click = async (label: string) => act(async () => {
    const button = [...host.querySelectorAll("button")].find(n => n.getAttribute("aria-label") === label || n.textContent === label)!;
    button.click();
  });
  return { host, click, unmount: () => act(() => root.unmount()) };
}
it("restores ink after the canvas attaches and fits page turns after the new region commits", async () => {
  const view = await mount();
  expect(state.order).toEqual(["restore", "template", "prime", "ingest", "prime"]);
  expect(state.fits.at(-1)).toEqual(["pad-0", "pad-0"]);
  await view.click("Next page"); expect(state.fits.at(-1)).toEqual(["pad-1", "pad-1"]);
  await view.click("Previous page"); expect(state.fits.at(-1)).toEqual(["pad-0", "pad-0"]);
  view.unmount();
});
it("saves all ink pages including clean empty pages and retains a draft after failure", async () => {
  const view = await mount(); await view.click("Draw");
  state.save.mockRejectedValueOnce(new Error("disk full"));
  await view.click("Save");
  expect(state.draft.mock.calls[0][1].snapshot.value.ink).toBe(state.pages);
  expect(state.save.mock.calls[0][3].value.board.inkPages.pageIds).toEqual([0, 1]);
  expect(state.removeDraft).not.toHaveBeenCalled();
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("draft is kept");
  await view.click("Save"); expect(state.removeDraft).toHaveBeenCalledOnce();
  expect(state.order.filter(n => n === "restore")).toHaveLength(1);
  view.unmount();
});
