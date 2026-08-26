/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubConflictSplit } from "./HubConflictSplit";
import type { AnnotatePadDto } from "../api/client";
import type { HubPadConflict } from "../util/hubConflictStash";

function annotateBody(name: string, updated: number, notes: unknown[]): AnnotatePadDto {
  return {
    id: "pad-1",
    name,
    hash: "h",
    doc_type: "pdf",
    updated_at: updated,
    source: `${name} source`,
    footnotes: notes,
    board: null as unknown as AnnotatePadDto["board"],
    agent: [],
  };
}

const CONFLICT: HubPadConflict = {
  kind: "annotate",
  id: "pad-1",
  stage: "pad",
  detail: "the hub has changes from another device",
  local: annotateBody("book", 900, [
    {
      id: "n1",
      kind: "note",
      anchor: {} as never,
      excerpt: "local only mark",
      createdAt: 1,
    },
    {
      id: "same",
      kind: "note",
      anchor: {} as never,
      excerpt: "kept here with new words",
      createdAt: 2,
    },
  ]),
  server: annotateBody("book", 500, [
    {
      id: "srv",
      kind: "coach",
      anchor: {} as never,
      excerpt: "hub only mark",
      createdAt: 3,
    },
    {
      id: "same",
      kind: "note",
      anchor: {} as never,
      excerpt: "kept there too",
      createdAt: 4,
    },
  ]),
};

function mount(conflict: HubPadConflict | null = CONFLICT) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onResolve = vi.fn();
  act(() => root.render(<HubConflictSplit conflict={conflict} onResolve={onResolve} />));
  return { root, onResolve };
}

describe("HubConflictSplit", () => {
  afterEach(() => {
    document.body.textContent = "";
  });

  it("renders Local left and Server right from the stash", () => {
    const { onResolve } = mount();
    const panes = document.querySelectorAll<HTMLElement>(".lc-hub-conflict-pane");
    expect(panes).toHaveLength(2);
    expect(panes[0]!.dataset.side).toBe("local");
    expect(panes[0]!.querySelector(".lc-hub-conflict-tab")!.textContent).toBe("Local");
    expect(panes[1]!.dataset.side).toBe("server");

    // Nothing resolves until both sides have a verdict.
    act(() => {
      (document.querySelector(".lc-hub-conflict-resolve") as HTMLButtonElement).click();
    });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps one whole pane on ✓/✕ and reports the choice", () => {
    const { onResolve } = mount();
    const localPane = document.querySelectorAll(".lc-hub-conflict-pane")[0]!;
    const keep = Array.from(localPane.querySelectorAll("button")).find((b) => b.textContent === "✓")!;
    const reject = Array.from(localPane.querySelectorAll("button")).find((b) => b.textContent === "✕")!;

    // ✕ rejects Local → Server is kept by force.
    act(() => reject.click());
    // ✓ on Local brings it back → both kept means a merge of footnotes.
    act(() => keep.click());
    act(() => {
      (document.querySelector(".lc-hub-conflict-resolve") as HTMLButtonElement).click();
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    const resolution = onResolve.mock.calls[0]![0];
    expect(resolution.pick).toBe("merged");
    // Both copies of the same-id-different-body mark survive (adjacent, per
    // mark); side-only marks default to their pane's verdict — three notes.
    expect(resolution.footnotes.map((n: { id: string }) => n.id)).toEqual([
      "n1",
      "same",
      "same",
      "srv",
    ]);
  });

  it("a per-mark pick keeps one extra copy; unkept panes drop their side-only marks", () => {
    const { onResolve } = mount();
    const [localPane, serverPane] = document.querySelectorAll(".lc-hub-conflict-pane");

    // Keep Server wholesale; Local stays undecided, so its side-only mark
    // falls with it.
    const serverKeep = Array.from(serverPane!.querySelectorAll("button")).find(
      (b) => b.textContent === "✓",
    )!;
    act(() => serverKeep.click());

    // One tap on a Local row's ✓ explicitly keeps that copy too (the plan's
    // per-mark ✓), which makes the resolve a merge.
    const localOnlyRow = Array.from(localPane!.querySelectorAll(".lc-hub-conflict-note")).find(
      (row) => row.textContent?.includes("local only mark"),
    )!;
    act(() => localOnlyRow.querySelector("button")!.click());

    act(() => {
      (document.querySelector(".lc-hub-conflict-resolve") as HTMLButtonElement).click();
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    const resolution = onResolve.mock.calls[0]![0];
    expect(resolution.pick).toBe("merged");
    const ids = resolution.footnotes.map((n: { id: string }) => n.id);
    expect(ids).toContain("srv");
    expect(ids).toContain("n1"); // explicitly kept despite Local being dropped
    expect(ids.filter((id: string) => id === "same")).toEqual(["same"]); // server copy only
  });
});
