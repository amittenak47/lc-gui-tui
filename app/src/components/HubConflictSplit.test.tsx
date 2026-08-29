/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubConflictSplit } from "./HubConflictSplit";
import type { AnnotatePadDto } from "../api/client";
import type { HubPadConflict } from "../util/hubConflictStash";
import { rememberPdfThumb, resetPdfThumbs } from "../modes/pdfFilm";

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
      anchor: { kind: "text", start: 0, end: 4, scope: "p1" },
      excerpt: "local only mark",
      createdAt: 1,
    },
    {
      id: "same",
      kind: "note",
      anchor: { kind: "text", start: 0, end: 4, scope: "page-2" },
      excerpt: "kept here with new words",
      createdAt: 2,
    },
  ]),
  server: annotateBody("book", 500, [
    {
      id: "srv",
      kind: "coach",
      anchor: { kind: "text", start: 0, end: 4, scope: "p3" },
      excerpt: "hub only mark",
      createdAt: 3,
    },
    {
      id: "same",
      kind: "note",
      anchor: { kind: "text", start: 0, end: 4, scope: "page-2" },
      excerpt: "kept there too",
      createdAt: 4,
    },
  ]),
};

function mount(
  conflict: HubPadConflict | null = CONFLICT,
  busy = false,
  extra: { docHash?: string; otherLabel?: string } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onResolve = vi.fn();
  act(() =>
    root.render(
      <HubConflictSplit
        conflict={conflict}
        busy={busy}
        otherLabel={extra.otherLabel}
        docHash={extra.docHash}
        onResolve={onResolve}
      />,
    ),
  );
  return { root, onResolve };
}

function resolveButton(): HTMLButtonElement {
  return document.querySelector(".lc-hub-conflict-resolve") as HTMLButtonElement;
}

function paneButton(side: 0 | 1, action: "keep" | "drop"): HTMLButtonElement {
  const pane = document.querySelectorAll(".lc-hub-conflict-pane")[side]!;
  return pane.querySelector(`.lc-hub-conflict-pane-head [data-action="${action}"]`) as HTMLButtonElement;
}

function noteByText(text: string): HTMLElement {
  return Array.from(document.querySelectorAll(".lc-hub-conflict-note")).find((row) =>
    row.textContent?.includes(text),
  ) as HTMLElement;
}

function inkRow(side: 0 | 1): HTMLElement {
  const pane = document.querySelectorAll(".lc-hub-conflict-pane")[side]!;
  return pane.querySelector(".lc-hub-conflict-ink") as HTMLElement;
}

describe("HubConflictSplit", () => {
  afterEach(() => {
    document.body.textContent = "";
    resetPdfThumbs();
  });

  it("renders Local left and the other device right from the stash", () => {
    const { onResolve } = mount();
    const panes = document.querySelectorAll<HTMLElement>(".lc-hub-conflict-pane");
    expect(panes).toHaveLength(2);
    expect(panes[0]!.dataset.side).toBe("local");
    expect(panes[0]!.querySelector(".lc-hub-conflict-tab")!.textContent).toBe("Local");
    expect(panes[1]!.dataset.side).toBe("server");
    expect(panes[1]!.querySelector(".lc-hub-conflict-tab")!.textContent).toBe("Tablet");
    expect(document.querySelectorAll(".lc-hub-conflict-preview")).toHaveLength(2);

    act(() => {
      resolveButton().click();
    });
    expect(onResolve).not.toHaveBeenCalled();
    expect(resolveButton().disabled).toBe(true);
  });

  it("top ✓ then the other ✕ keeps that whole copy", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "keep").click());
    act(() => paneButton(1, "drop").click());
    act(() => resolveButton().click());
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]![0]).toEqual({ pick: "local", ink: "local" });
  });

  it("a per-mark keep adds a hub-only note without requiring the other pane ✓", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "keep").click());
    act(() => {
      noteByText("hub only mark").querySelector('[data-action="keep"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => resolveButton().click());
    expect(onResolve).toHaveBeenCalledTimes(1);
    const resolution = onResolve.mock.calls[0]![0];
    expect(resolution.pick).toBe("merged");
    expect(resolution.ink).toBe("local");
    const ids = resolution.footnotes.map((n: { id: string }) => n.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("srv");
    expect(ids.filter((id: string) => id === "same")).toEqual(["same"]);
  });
});

describe("HubConflictSplit guards", () => {
  afterEach(() => {
    document.body.textContent = "";
    resetPdfThumbs();
  });

  it("takes no taps while the choice is being written", () => {
    const { onResolve } = mount(CONFLICT, true);
    act(() => paneButton(0, "keep").click());
    expect(resolveButton().disabled).toBe(true);
    act(() => resolveButton().click());
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("will not keep a server copy it could not read", () => {
    const { onResolve } = mount({ ...CONFLICT, server: null });

    act(() => paneButton(1, "keep").click());
    expect(resolveButton().disabled).toBe(true);
    act(() => resolveButton().click());
    expect(onResolve).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("could not be read");
  });

  it("still lets the local copy be kept when the hub copy is missing", () => {
    const { onResolve } = mount({ ...CONFLICT, server: null });
    act(() => paneButton(0, "keep").click());
    act(() => resolveButton().click());
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]![0].pick).toBe("local");
    expect(onResolve.mock.calls[0]![0].ink).toBe("local");
  });
});

describe("HubConflictSplit ink and labels", () => {
  afterEach(() => {
    document.body.textContent = "";
    resetPdfThumbs();
  });

  it("keeps only this device's copy and its ink on a single Local ✓ plus the other ✕", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "keep").click());
    act(() => paneButton(1, "drop").click());
    act(() => resolveButton().click());
    expect(onResolve.mock.calls[0]![0]).toEqual({ pick: "local", ink: "local" });
  });

  it("lets both columns be dropped — the file stays, notes and ink do not", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "drop").click());
    act(() => paneButton(1, "drop").click());
    expect(
      (document.querySelectorAll(".lc-hub-conflict-pane")[0] as HTMLElement).dataset.verdict,
    ).toBe("reject");
    expect(
      (document.querySelectorAll(".lc-hub-conflict-pane")[1] as HTMLElement).dataset.verdict,
    ).toBe("reject");
    expect(resolveButton().disabled).toBe(false);
    act(() => resolveButton().click());
    expect(onResolve.mock.calls[0]![0].pick).toBe("merged");
    expect(onResolve.mock.calls[0]![0].ink).toBe("none");
    expect(onResolve.mock.calls[0]![0].footnotes).toEqual([]);
  });

  it("✕ ink on both sides keeps the file with no handwriting", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "keep").click());
    act(() => paneButton(1, "drop").click());
    act(() => {
      inkRow(0).querySelector('[data-action="drop"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => resolveButton().click());
    expect(onResolve.mock.calls[0]![0].pick).toBe("local");
    expect(onResolve.mock.calls[0]![0].ink).toBe("none");
  });

  it("names the right pane with otherLabel", () => {
    mount(CONFLICT, false, { otherLabel: "Desktop" });
    const panes = document.querySelectorAll(".lc-hub-conflict-pane");
    expect(panes[1]!.querySelector(".lc-hub-conflict-tab")!.textContent).toBe("Desktop");
  });

  it("clicking a note shows that page in both preview panes", () => {
    rememberPdfThumb("h", 2, "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
    mount(CONFLICT, false, { docHash: "h" });
    expect(
      (document.querySelector(".lc-hub-conflict-preview") as HTMLElement).dataset.page,
    ).toBe("1");
    act(() => {
      noteByText("kept here with new words").click();
    });
    const previews = document.querySelectorAll<HTMLElement>(".lc-hub-conflict-preview");
    expect(previews).toHaveLength(2);
    expect(previews[0]!.dataset.page).toBe("2");
    expect(previews[1]!.dataset.page).toBe("2");
  });

  it("Keep selection enables after every row is settled without the pane header", () => {
    const { onResolve } = mount();
    expect(resolveButton().disabled).toBe(true);
    act(() => {
      inkRow(1)
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      noteByText("local only mark")
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      noteByText("kept here with new words")
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      noteByText("hub only mark")
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(paneButton(0, "keep").getAttribute("aria-pressed")).not.toBe("true");
    expect(paneButton(1, "keep").getAttribute("aria-pressed")).not.toBe("true");
    expect(resolveButton().disabled).toBe(false);
    act(() => resolveButton().click());
    expect(onResolve).toHaveBeenCalledTimes(1);
    const resolution = onResolve.mock.calls[0]![0];
    expect(resolution.pick).toBe("merged");
    expect(resolution.ink).toBe("server");
    const ids = resolution.footnotes.map((n: { id: string }) => n.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("same");
    expect(ids).toContain("srv");
  });

  it("lays the change list over the full-size page preview", () => {
    mount();
    const body = document.querySelector(".lc-hub-conflict-pane-body") as HTMLElement;
    const preview = body.querySelector(".lc-hub-conflict-preview");
    const list = body.querySelector(".lc-hub-conflict-list");
    expect(preview).toBeTruthy();
    expect(list).toBeTruthy();
    expect(list!.compareDocumentPosition(preview!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });
});

/*
 * What actually reached each pane's document.
 *
 * The preview renders marks through `DocSelectionLayer`, which places them
 * from measured scope roots — there is no layout in jsdom, so nothing paints
 * and there is nothing to count. The question here is not how a ribbon looks
 * but which copies were handed over, so the preview is stood in for by
 * something that records its props. `ConflictPagePreview` keeps its own
 * behaviour under test next to `pdfVisibleFromSpans`.
 */
describe("what the panes are asked to draw", () => {
  afterEach(() => {
    document.body.textContent = "";
    vi.doUnmock("./ConflictPagePreview");
    vi.resetModules();
  });

  async function mountSpied(conflict: HubPadConflict = CONFLICT) {
    vi.resetModules();
    vi.doMock("./ConflictPagePreview", () => ({
      ConflictPagePreview: (props: {
        page: number;
        notes?: readonly { id: string }[];
        showInk?: boolean;
      }) => (
        <div
          className="lc-hub-conflict-preview"
          data-page={String(props.page)}
          data-notes={(props.notes ?? []).map((note) => note.id).join(",")}
          data-ink={props.showInk ? "on" : "off"}
        />
      ),
    }));
    const { HubConflictSplit: Split } = await import("./HubConflictSplit");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Split conflict={conflict} onResolve={vi.fn()} />));
    return { root };
  }

  const panes = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".lc-hub-conflict-preview"));
  const notesOn = (side: 0 | 1) =>
    (panes()[side]!.dataset.notes ?? "").split(",").filter(Boolean);

  /*
   * The ✓ / ✕ on one row, in one pane.
   *
   * By mark id, not by position or text: a row only renders on the side that
   * has that copy, so the two panes hold different rows in different orders,
   * and each shows its own excerpt where the words differ.
   */
  const tick = (side: 0 | 1, id: string, action: "keep" | "drop") => {
    const pane = document.querySelectorAll(".lc-hub-conflict-pane")[side]!;
    const row = pane.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!;
    act(() => {
      (row.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
    });
  };
  const tickInk = (side: 0 | 1, action: "keep" | "drop") => {
    act(() => {
      (inkRow(side).querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
    });
  };
  /** The mark both sides changed, and the one only the hub has. */
  const SAME = "same";
  const HUB_ONLY = "srv";
  const inkOn = (side: 0 | 1) => panes()[side]!.dataset.ink === "on";

  it("draws nothing for a change nobody has answered for", async () => {
    /*
     * Both sides start untoggled, and that is the honest picture: a change
     * with no decision yet is not something either pane is showing you.
     */
    await mountSpied();
    expect(notesOn(0)).toEqual([]);
    expect(notesOn(1)).toEqual([]);
    expect(inkOn(0)).toBe(false);
    expect(inkOn(1)).toBe(false);
  });

  it("does not draw a mark merely because its row was tapped", async () => {
    // Tapping is asking to see the row, not answering for it. A page that
    // disagrees with the ticks beside it is the one thing this must not do.
    await mountSpied();
    act(() => noteByText("kept here with new words").click());
    expect(notesOn(0)).toEqual([]);
    expect(notesOn(1)).toEqual([]);
  });

  it("draws the side you kept, and only that side", async () => {
    await mountSpied();

    tick(0, SAME, "keep");
    expect(notesOn(0)).toEqual(["same"]);
    expect(notesOn(1)).toEqual([]);

    tick(1, SAME, "keep");
    expect(notesOn(0)).toEqual(["same"]);
    expect(notesOn(1)).toEqual(["same"]);
  });

  it("stops drawing a side once its ✓ is taken back", async () => {
    await mountSpied();
    tick(0, SAME, "keep");
    tick(1, SAME, "keep");
    expect(notesOn(0)).toEqual(["same"]);

    // Tapping ✓ again clears it; ✕ drops the other outright.
    tick(0, SAME, "keep");
    tick(1, SAME, "drop");
    expect(notesOn(0)).toEqual([]);
    expect(notesOn(1)).toEqual([]);
  });

  it("draws a side-only mark on the side that has it", async () => {
    await mountSpied();
    tick(1, HUB_ONLY, "keep");
    expect(notesOn(1)).toEqual(["srv"]);
    expect(notesOn(0)).toEqual([]);
  });

  it("answers for handwriting the same way", async () => {
    await mountSpied();
    // Focus alone draws nothing.
    act(() => inkRow(0).click());
    expect(inkOn(0)).toBe(false);
    expect(inkOn(1)).toBe(false);

    tickInk(0, "keep");
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(false);

    tickInk(1, "keep");
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(true);

    tickInk(0, "keep");
    expect(inkOn(0)).toBe(false);
    expect(inkOn(1)).toBe(true);
  });

  it("leaves earlier decisions drawn while you answer the next row", async () => {
    // Deciding the ink does not un-draw the mark you already kept.
    await mountSpied();
    tick(0, SAME, "keep");
    expect(notesOn(0)).toEqual(["same"]);

    act(() => inkRow(0).click());
    tickInk(0, "keep");
    expect(notesOn(0)).toEqual(["same"]);
    expect(inkOn(0)).toBe(true);
  });

  it("a column ✓ is the same rule applied to every row", async () => {
    /*
     * Keeping the whole Local column draws every Local change and leaves the
     * other pane alone — the same answer as ticking each row by hand.
     */
    await mountSpied();
    act(() => paneButton(0, "keep").click());
    expect(notesOn(0)).toEqual(["n1", "same"]);
    expect(inkOn(0)).toBe(true);
    expect(notesOn(1)).toEqual([]);
    expect(inkOn(1)).toBe(false);
  });
});

describe("the mark hub, one per pane", () => {
  // The hub portals to `document.body`, so a split left mounted keeps its
  // cards in the next test's count.
  afterEach(() => {
    document.body.textContent = "";
  });

  /**
   * The same mark on both sides, each carrying its own note.
   *
   * That difference is the point: the live hub in the workspace reads *this*
   * device's footnotes, so it could only ever show one of the two.
   */
  const BOTH: HubPadConflict = {
    ...CONFLICT,
    local: annotateBody("book", 900, [
      {
        id: "same",
        kind: "note",
        anchor: { kind: "text", start: 0, end: 4, scope: "page-2" },
        excerpt: "kept here with new words",
        createdAt: 2,
        notes: [{ id: "ln", text: "note from this device", createdAt: 1, updatedAt: 1 }],
      },
    ]),
    server: annotateBody("book", 500, [
      {
        id: "same",
        kind: "note",
        anchor: { kind: "text", start: 0, end: 4, scope: "page-2" },
        excerpt: "kept there too",
        createdAt: 4,
        notes: [{ id: "sn", text: "note from the other one", createdAt: 2, updatedAt: 2 }],
      },
    ]),
  };

  function hubs() {
    return document.querySelectorAll(".lc-footnote-overview");
  }

  it("opens this side's copy on each pane when a mark is tapped", () => {
    /*
     * Tapping a row scrolled the pane and nothing else — you had to keep a
     * mark to find out what was in it.
     */
    mount(BOTH);
    act(() => noteByText("kept here with new words").click());

    expect(hubs()).toHaveLength(2);
    const text = document.body.textContent ?? "";
    expect(text).toContain("note from this device");
    expect(text).toContain("note from the other one");
  });

  it("closes both hubs when handwriting takes the focus", () => {
    mount(BOTH);
    act(() => noteByText("kept here with new words").click());
    expect(hubs()).toHaveLength(2);

    act(() => inkRow(0).click());
    expect(hubs()).toHaveLength(0);
  });

  it("offers no way to write into a copy that may be about to lose", () => {
    // Keep is the only write in this flow; anything typed into the losing copy
    // would be thrown away without saying so.
    mount(BOTH);
    act(() => noteByText("kept here with new words").click());

    expect(document.querySelectorAll(".lc-footnote-overview-add")).toHaveLength(0);
    // Still readable, which is the whole reason it is open.
    expect(document.body.textContent).toContain("note from this device");
  });

  it("shows one hub when only one side has that mark", () => {
    mount();
    act(() => noteByText("local only mark").click());
    expect(hubs()).toHaveLength(1);
  });
});
