/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubConflictSplit } from "./HubConflictSplit";
import type { AnnotatePadDto } from "../api/client";
import type { HubPadConflict } from "../util/hubConflictStash";

let root: ReturnType<typeof createRoot>;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => { act(() => root?.unmount()); document.body.textContent = ""; vi.unstubAllGlobals(); });
const thread = { rootId: "chat", title: "Identical chat", createdAt: 1 };
function mount(differentNote = true) {
  const note = { id: "mark", kind: "coach", createdAt: 1, excerpt: "Local mark",
    anchor: { kind: "text", start: 0, end: 4, scope: "p1" }, threads: [thread] };
  const local = { id: "book", name: "Book", hash: "h", doc_type: "markdown", source: "text",
    updated_at: 1, board: null, agent: [], footnotes: [note] } as unknown as AnnotatePadDto;
  const server = { ...local, label: "Changed label", footnotes: [{ ...note, excerpt: differentNote ? "Hub mark" : note.excerpt }] };
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onResolve = vi.fn();
  act(() => root.render(<HubConflictSplit conflict={{kind:"annotate",id:"book",stage:"pad",detail:"Conflict",local,server} as HubPadConflict} onResolve={onResolve} />));
  return onResolve;
}
const filter = () => document.querySelector<HTMLButtonElement>('[aria-label="Differences only"]')!;
const chats = () => [...document.querySelectorAll<HTMLElement>('[data-note-id="mark::chats:chat"]')];

it("hides identical chats under a changed mark and shows them when filtering is off", () => {
  mount(); expect(filter().getAttribute("aria-pressed")).toBe("true"); expect(chats()).toHaveLength(0);
  act(() => filter().click()); expect(chats()).toHaveLength(2);
  expect(chats().every(row => row.textContent?.includes("Same"))).toBe(true);
  act(() => filter().click()); expect(chats()).toHaveLength(0);
  expect(document.querySelectorAll('[data-note-id="mark"]')).toHaveLength(2);
});

it("hides a matching chat after an explicit drop without forgetting that choice", () => {
  mount(); act(() => filter().click());
  act(() => chats()[0]!.querySelector<HTMLButtonElement>('[data-action="drop"]')!.click());
  act(() => filter().click()); expect(chats()).toHaveLength(0);
  act(() => filter().click()); expect(chats()[0]!.dataset.pick).toBe("drop");
});

it("shows zero changes when all listed content is identical", () => {
  mount(false); expect(chats()).toHaveLength(0);
  expect([...document.querySelectorAll('.lc-hub-conflict-dock-count')].map(n => n.textContent)).toEqual(["0", "0"]);
});
