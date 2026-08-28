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
