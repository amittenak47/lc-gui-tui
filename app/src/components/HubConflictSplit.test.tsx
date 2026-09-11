/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubConflictSplit } from "./HubConflictSplit";
import type { AnnotatePadDto, WhiteboardPadDto } from "../api/client";
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

/** Same notes as CONFLICT, plus one page of handwriting that disagrees. */
const WITH_INK: HubPadConflict = {
  ...CONFLICT,
  localInkPageIds: [1],
  hubInkPageIds: [1],
  localInkStamps: [{ pageId: 1, updatedAt: 10 }],
  hubInkStamps: [{ pageId: 1, updatedAt: 20 }],
};

const EMPTY_INK = { inkPages: [] as const, footnoteInkPages: [] as const };

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

  it("leaves keep and drop as theme circles until they are pressed", () => {
    mount();
    const keep = paneButton(0, "keep");
    const drop = paneButton(0, "drop");
    expect(keep.getAttribute("aria-pressed")).toBe("false");
    expect(keep.className).toBe("lc-doc-confirm-btn");
    expect(drop.className).toBe("lc-doc-confirm-btn");
    act(() => keep.click());
    expect(paneButton(0, "keep").className).toContain("lc-doc-confirm-yes");
    expect(paneButton(1, "drop").className).toContain("lc-doc-confirm-no");
  });

  it("top ✓ keeps that whole copy and discards the other column", () => {
    const { onResolve } = mount();
    act(() => paneButton(0, "keep").click());
    expect(paneButton(1, "drop").getAttribute("aria-pressed")).toBe("true");
    act(() => resolveButton().click());
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]![0]).toEqual({
      pick: "local",
      ink: "none",
      ...EMPTY_INK,
    });
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
    expect(resolution.ink).toBe("none");
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
    expect(onResolve.mock.calls[0]![0].ink).toBe("none");
  });
});

describe("HubConflictSplit ink and labels", () => {
  afterEach(() => {
    document.body.textContent = "";
    resetPdfThumbs();
  });

  it("keeps only this device's copy and its ink on a single Local ✓", () => {
    const { onResolve } = mount(WITH_INK);
    act(() => paneButton(0, "keep").click());
    expect(paneButton(1, "drop").getAttribute("aria-pressed")).toBe("true");
    act(() => resolveButton().click());
    expect(onResolve.mock.calls[0]![0]).toEqual({
      pick: "local",
      ink: "local",
      inkPages: [{ pageId: 1, choice: "local" }],
      footnoteInkPages: [],
    });
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
    expect(onResolve.mock.calls[0]![0].inkPages).toEqual([]);
  });

  it("✕ ink on both sides keeps the file with no handwriting", () => {
    const { onResolve } = mount(WITH_INK);
    act(() => paneButton(0, "keep").click());
    act(() => {
      inkRow(0).querySelector('[data-action="drop"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => resolveButton().click());
    expect(onResolve.mock.calls[0]![0].pick).toBe("local");
    expect(onResolve.mock.calls[0]![0].ink).toBe("none");
    expect(onResolve.mock.calls[0]![0].inkPages).toEqual([{ pageId: 1, choice: "none" }]);
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
    const { onResolve } = mount(WITH_INK);
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
    expect(resolution.inkPages).toEqual([{ pageId: 1, choice: "server" }]);
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

  it("omits a footnote that is already the same on both devices", () => {
    const twin = {
      id: "twin",
      kind: "note" as const,
      anchor: { kind: "text" as const, start: 0, end: 4, scope: "p1" },
      excerpt: "unchanged quote",
      createdAt: 8,
    };
    const conflict: HubPadConflict = {
      ...CONFLICT,
      local: annotateBody("book", 900, [
        ...((CONFLICT.local as AnnotatePadDto).footnotes as unknown[]),
        twin,
      ]),
      server: annotateBody("book", 500, [
        ...((CONFLICT.server as AnnotatePadDto).footnotes as unknown[]),
        twin,
      ]),
    };
    const { onResolve } = mount(conflict);
    expect(document.querySelector('[data-note-id="twin"]')).toBeNull();
    act(() => paneButton(0, "keep").click());
    act(() => {
      noteByText("hub only mark")
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => resolveButton().click());
    const ids = onResolve.mock.calls[0]![0].footnotes.map((n: { id: string }) => n.id);
    expect(ids).toContain("twin");
    expect(ids).toContain("n1");
    expect(ids).toContain("srv");
  });

  it("lists only handwriting pages that disagree, and keeps A / B / A+B per page", () => {
    const conflict: HubPadConflict = {
      ...CONFLICT,
      localInkStamps: [
        { pageId: 1, updatedAt: 10 },
        { pageId: 2, updatedAt: 20 },
        { pageId: 4, updatedAt: 40 },
      ],
      hubInkStamps: [
        { pageId: 1, updatedAt: 10 },
        { pageId: 2, updatedAt: 21 },
        { pageId: 3, updatedAt: 30 },
      ],
    };
    const { onResolve } = mount(conflict);
    expect(document.querySelector('[data-note-id="__ink__:1"]')).toBeNull();
    expect(document.querySelector('[data-note-id="__ink__:2"]')).toBeTruthy();
    expect(document.querySelector('[data-note-id="__ink__:3"]')).toBeTruthy();
    expect(document.querySelector('[data-note-id="__ink__:4"]')).toBeTruthy();

    act(() => paneButton(0, "keep").click());
    // Page 2: keep both copies so the strokes merge.
    act(() => {
      const row = document.querySelectorAll(".lc-hub-conflict-pane")[1]!
        .querySelector('[data-note-id="__ink__:2"]')!;
      row.querySelector('[data-action="keep"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => resolveButton().click());
    const inkPages = onResolve.mock.calls[0]![0].inkPages as Array<{
      pageId: number;
      choice: string;
    }>;
    expect(inkPages).toEqual([
      { pageId: 2, choice: "merged" },
      { pageId: 3, choice: "none" },
      { pageId: 4, choice: "local" },
    ]);
  });

  it("fills a kept subentry and says how many choices remain", () => {
    mount(WITH_INK);
    act(() => {
      inkRow(0)
        .querySelector('[data-action="keep"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(inkRow(0).classList.contains("is-keep")).toBe(true);
    expect(inkRow(0).getAttribute("data-pick")).toBe("keep");
    expect(document.querySelector(".lc-hub-conflict")!.classList.contains("is-picking")).toBe(
      true,
    );
    expect(document.body.textContent).toMatch(/still need/);
  });

  it("fills a dropped subentry in red", () => {
    mount(WITH_INK);
    act(() => {
      inkRow(1)
        .querySelector('[data-action="drop"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(inkRow(1).classList.contains("is-drop")).toBe(true);
    expect(inkRow(1).getAttribute("data-pick")).toBe("drop");
  });

  it("stacks notebook pages in the preview even when ink is one page-1 shard", () => {
    const elements = [
      { y: 0, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
      { y: 4264, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 1 } },
    ];
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 1,
      board: { elements } as WhiteboardPadDto["board"],
      agent: [],
    });
    mount({
      kind: "whiteboard",
      id: "w1",
      stage: "ink",
      detail: "both wrote",
      local: body(10),
      server: body(20),
      localInkPageIds: [1],
      hubInkPageIds: [1],
      localInkStamps: [{ pageId: 1, updatedAt: 10 }],
      hubInkStamps: [{ pageId: 1, updatedAt: 20 }],
    });
    expect(document.body.textContent).toMatch(/Handwriting \(page 1\)/);
    expect(document.body.textContent).not.toMatch(/Handwriting \(page 2\)/);
    expect(document.querySelectorAll('[data-pdf-page="1"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-pdf-page="2"]').length).toBeGreaterThan(0);
  });

  it("lists each notebook page after a lumped page-1 blob decodes", async () => {
    const { encodeInkOps, packEncodedInk } = await import("../canvas/inkCodec");
    const { bytesToB64 } = await import("../api/nativeHttp");
    const { NO_PRESSURE } = await import("../canvas/rasterInk");
    const { SCRATCH_PAGE_H, SCRATCH_PAGE_GUTTER } = await import("../templates/whiteboard");
    const y2 = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER + 40;
    const gz = bytesToB64(
      packEncodedInk(
        encodeInkOps([
          {
            kind: "draw",
            color: "#111",
            baseWidth: 4,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            points: [
              { x: 80, y: 40, pressure: NO_PRESSURE },
              { x: 120, y: 40, pressure: NO_PRESSURE },
            ],
          },
          {
            kind: "draw",
            color: "#111",
            baseWidth: 4,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            points: [
              { x: 80, y: y2, pressure: NO_PRESSURE },
              { x: 120, y: y2, pressure: NO_PRESSURE },
            ],
          },
        ]),
      ),
    );
    const elements = [
      { y: 0, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
      { y: 4264, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 1 } },
    ];
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 2,
      board: { elements } as WhiteboardPadDto["board"],
      agent: [],
    });
    mount({
      kind: "whiteboard",
      id: "w1",
      stage: "ink",
      detail: "both wrote",
      local: body(10),
      server: body(20),
      localInkPageIds: [1],
      hubInkPageIds: [1],
      localInkStamps: [{ pageId: 1, updatedAt: 10 }],
      hubInkStamps: [{ pageId: 1, updatedAt: 20 }],
      localInk: [{ kind: "whiteboard", key: "w1", page_id: 1, updated_at: 10, gz }],
      serverInk: [],
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toMatch(/Handwriting \(page 1\)/);
    expect(document.body.textContent).toMatch(/Handwriting \(page 2\)/);
  });

  it("clicking a handwriting page jumps both previews to that sheet", async () => {
    const { encodeInkOps, packEncodedInk } = await import("../canvas/inkCodec");
    const { bytesToB64 } = await import("../api/nativeHttp");
    const { NO_PRESSURE } = await import("../canvas/rasterInk");
    const { SCRATCH_PAGE_H, SCRATCH_PAGE_GUTTER } = await import("../templates/whiteboard");
    const y2 = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER + 40;
    const gz = bytesToB64(
      packEncodedInk(
        encodeInkOps([
          {
            kind: "draw",
            color: "#111",
            baseWidth: 4,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            points: [
              { x: 80, y: 40, pressure: NO_PRESSURE },
              { x: 120, y: 40, pressure: NO_PRESSURE },
            ],
          },
          {
            kind: "draw",
            color: "#111",
            baseWidth: 4,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            points: [
              { x: 80, y: y2, pressure: NO_PRESSURE },
              { x: 120, y: y2, pressure: NO_PRESSURE },
            ],
          },
        ]),
      ),
    );
    const elements = [
      { y: 0, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
      { y: 4264, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 1 } },
    ];
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 2,
      board: { elements } as WhiteboardPadDto["board"],
      agent: [],
    });
    mount({
      kind: "whiteboard",
      id: "w1",
      stage: "ink",
      detail: "both wrote",
      local: body(10),
      server: body(20),
      localInkPageIds: [1],
      hubInkPageIds: [1],
      localInkStamps: [{ pageId: 1, updatedAt: 10 }],
      hubInkStamps: [{ pageId: 1, updatedAt: 20 }],
      localInk: [{ kind: "whiteboard", key: "w1", page_id: 1, updated_at: 10, gz }],
      serverInk: [],
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const previews = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".lc-hub-conflict-preview"));
    expect(previews()[0]!.dataset.page).toBe("1");
    act(() => noteByText("Handwriting (page 2)").click());
    expect(previews().map((pane) => pane.dataset.page)).toEqual(["2", "2"]);
    act(() => noteByText("Handwriting (page 1)").click());
    expect(previews().map((pane) => pane.dataset.page)).toEqual(["1", "1"]);
  });

  it("lists virtual sheets of a grown page-1 whiteboard after the blob decodes", async () => {
    const { encodeInkOps, packEncodedInk } = await import("../canvas/inkCodec");
    const { bytesToB64 } = await import("../api/nativeHttp");
    const { NO_PRESSURE } = await import("../canvas/rasterInk");
    const { SCRATCH_PAGE_H, SCRATCH_PAGE_GUTTER } = await import("../templates/whiteboard");
    const y2 = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER + 40;
    const draw = (y: number) => ({
      kind: "draw" as const,
      color: "#111",
      baseWidth: 4,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      points: [
        { x: 80, y, pressure: NO_PRESSURE },
        { x: 120, y, pressure: NO_PRESSURE },
      ],
    });
    const gz = bytesToB64(packEncodedInk(encodeInkOps([draw(40), draw(y2)])));
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 1,
      board: {
        elements: [
          { y: 0, height: 8000, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
        ],
      } as WhiteboardPadDto["board"],
      agent: [],
    });
    mount({
      kind: "whiteboard",
      id: "w1",
      stage: "ink",
      detail: "both wrote",
      local: body(10),
      server: body(20),
      localInkPageIds: [1],
      hubInkPageIds: [1],
      localInkStamps: [{ pageId: 1, updatedAt: 10 }],
      hubInkStamps: [{ pageId: 1, updatedAt: 20 }],
      localInk: [{ kind: "whiteboard", key: "w1", page_id: 1, updated_at: 10, gz }],
      serverInk: [],
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toMatch(/Handwriting \(page 1\)/);
    expect(document.body.textContent).toMatch(/Handwriting \(page 2\)/);
  });

  it("lists footnote scratch per mark board, not as one pad row", () => {
    mount({
      ...CONFLICT,
      footnoteInk: [
        {
          wbId: "n1",
          localPageIds: [1],
          hubPageIds: [1],
          localPages: [{ pageId: 1, updatedAt: 1 }],
          hubPages: [{ pageId: 1, updatedAt: 2 }],
        },
      ],
    });
    expect(document.body.textContent).toMatch(/Scratch \(n1, page 1\)/);
    expect(document.body.textContent).not.toMatch(/Handwriting \(page 1\)/);
  });

  it("does not list spanning page 0 as a handwriting row", () => {
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 2,
      board: {
        elements: [
          { y: 0, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
          { y: 4264, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 1 } },
        ],
      } as WhiteboardPadDto["board"],
      agent: [],
    });
    mount({
      kind: "whiteboard",
      id: "w1",
      stage: "pad",
      detail: "the hub has changes from another device",
      local: body(10),
      server: body(20),
      localInkPageIds: [0, 1],
      hubInkPageIds: [0, 1],
      localInkStamps: [
        { pageId: 0, updatedAt: 10 },
        { pageId: 1, updatedAt: 11 },
      ],
      hubInkStamps: [
        { pageId: 0, updatedAt: 20 },
        { pageId: 1, updatedAt: 21 },
      ],
    });
    expect(document.body.textContent).not.toMatch(/Handwriting \(page 0\)/);
    expect(document.body.textContent).toMatch(/Handwriting \(page 1\)/);
    expect(
      document.querySelectorAll('.lc-hub-conflict-preview[aria-busy="true"]'),
    ).toHaveLength(0);
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

  async function mountSpied(
    conflict: HubPadConflict = CONFLICT,
    extra: {
      fetchPreviewInk?: (pageId: number) => Promise<{
        local: {
          kind: "annotate" | "whiteboard";
          key: string;
          page_id: number;
          updated_at: number;
          gz: string;
        } | null;
        server: {
          kind: "annotate" | "whiteboard";
          key: string;
          page_id: number;
          updated_at: number;
          gz: string;
        } | null;
      }>;
    } = {},
  ) {
    vi.resetModules();
    vi.doMock("./ConflictPagePreview", () => ({
      ConflictPagePreview: (props: {
        page: number;
        focusKey?: string;
        notes?: readonly { id: string }[];
        showInk?: boolean;
        inkPages?: readonly { page_id: number }[];
        droppedPages?: readonly number[];
        keptPages?: readonly number[];
      }) => (
        <div
          className="lc-hub-conflict-preview"
          data-page={String(props.page)}
          data-focus={props.focusKey ?? ""}
          data-notes={(props.notes ?? []).map((note) => note.id).join(",")}
          data-ink={props.showInk ? "on" : "off"}
          data-ink-pages={(props.inkPages ?? []).map((row) => row.page_id).join(",")}
          data-dropped={(props.droppedPages ?? []).join(",")}
          data-kept={(props.keptPages ?? []).join(",")}
        />
      ),
    }));
    const { HubConflictSplit: Split } = await import("./HubConflictSplit");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <Split conflict={conflict} onResolve={vi.fn()} fetchPreviewInk={extra.fetchPreviewInk} />,
      ),
    );
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
  const droppedPagesOn = (side: 0 | 1) =>
    (panes()[side]!.dataset.dropped ?? "").split(",").filter(Boolean);
  const keptPagesOn = (side: 0 | 1) =>
    (panes()[side]!.dataset.kept ?? "").split(",").filter(Boolean);

  it("draws nothing for a mark nobody has answered for", async () => {
    /*
     * Both sides start untoggled, and that is the honest picture for marks: a
     * change with no decision yet is not something either pane is showing you.
     * Handwriting is different — the page itself has to be visible.
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
    await mountSpied(WITH_INK);
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(true);

    tickInk(0, "keep");
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(true);
    expect(keptPagesOn(0)).toEqual(["1"]);
    expect(droppedPagesOn(1)).toEqual(["1"]);

    tickInk(1, "keep");
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(true);
    expect(keptPagesOn(0)).toEqual(["1"]);
    expect(keptPagesOn(1)).toEqual(["1"]);
    expect(droppedPagesOn(0)).toEqual([]);
    expect(droppedPagesOn(1)).toEqual([]);

    tickInk(0, "drop");
    expect(inkOn(0)).toBe(true);
    expect(inkOn(1)).toBe(true);
    expect(droppedPagesOn(0)).toEqual(["1"]);
    expect(keptPagesOn(1)).toEqual(["1"]);
  });

  it("leaves earlier decisions drawn while you answer the next row", async () => {
    // Deciding the ink does not un-draw the mark you already kept.
    await mountSpied(WITH_INK);
    tick(0, SAME, "keep");
    expect(notesOn(0)).toEqual(["same"]);

    act(() => inkRow(0).click());
    tickInk(0, "keep");
    expect(notesOn(0)).toEqual(["same"]);
    expect(inkOn(0)).toBe(true);
  });

  it("a column ✓ keeps that side and discards the other", async () => {
    await mountSpied(WITH_INK);
    act(() => paneButton(0, "keep").click());
    expect(notesOn(0)).toEqual(["n1", "same"]);
    expect(inkOn(0)).toBe(true);
    expect(notesOn(1)).toEqual([]);
    expect(inkOn(1)).toBe(true);
    expect(droppedPagesOn(1)).toEqual(["1"]);
    expect(keptPagesOn(0)).toEqual(["1"]);
    expect(paneButton(1, "drop").getAttribute("aria-pressed")).toBe("true");
  });

  const FAR: HubPadConflict = {
    ...CONFLICT,
    inkPageId: 12,
    localInk: [
      { kind: "annotate", key: "pad-1", page_id: 12, updated_at: 1, gz: "local-12" },
    ],
    serverInk: [
      { kind: "annotate", key: "pad-1", page_id: 12, updated_at: 1, gz: "hub-12" },
    ],
    local: annotateBody("book", 900, [
      ...((CONFLICT.local as AnnotatePadDto).footnotes as unknown[]),
      {
        id: "far",
        kind: "note",
        anchor: { kind: "text", start: 0, end: 4, scope: "p40" },
        excerpt: "page forty mark",
        createdAt: 9,
      },
    ]),
  };

  it("jumps both panes to the focused change's page", async () => {
    await mountSpied(FAR);
    expect(panes().map((pane) => pane.dataset.page)).toEqual(["12", "12"]);
    act(() => noteByText("page forty mark").click());
    expect(panes().map((pane) => pane.dataset.page)).toEqual(["40", "40"]);
    expect(panes()[0]!.dataset.focus).toBe("far");
  });

  it("fetches that page's ink for the overlay, not the rest of the pad", async () => {
    const fetchPreviewInk = vi.fn(async (pageId: number) => ({
      local: {
        kind: "annotate" as const,
        key: "pad-1",
        page_id: pageId,
        updated_at: 1,
        gz: "local-extra",
      },
      server: {
        kind: "annotate" as const,
        key: "pad-1",
        page_id: pageId,
        updated_at: 1,
        gz: "hub-extra",
      },
    }));
    await mountSpied(FAR, { fetchPreviewInk });
    expect(fetchPreviewInk).not.toHaveBeenCalled();
    await act(async () => {
      noteByText("page forty mark").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPreviewInk.mock.calls.map((call) => call[0])).toEqual([40]);
    expect(panes()[0]!.dataset.inkPages).toBe("12,40");
    expect(panes()[1]!.dataset.inkPages).toBe("12,40");
  });

  it("does not treat a page-0 spanning shard as covering page 1", async () => {
    const fetchPreviewInk = vi.fn(async (pageId: number) => ({
      local: {
        kind: "whiteboard" as const,
        key: "w1",
        page_id: pageId,
        updated_at: 1,
        gz: "local-1",
      },
      server: {
        kind: "whiteboard" as const,
        key: "w1",
        page_id: pageId,
        updated_at: 1,
        gz: "hub-1",
      },
    }));
    const body = (updated: number): WhiteboardPadDto => ({
      id: "w1",
      title: "Exam 1",
      updated_at: updated,
      page_count: 1,
      board: {
        elements: [
          { y: 0, height: 4200, customData: { lcScratchFrame: true, lcScratchPage: 0 } },
        ],
      } as WhiteboardPadDto["board"],
      agent: [],
    });
    await mountSpied(
      {
        kind: "whiteboard",
        id: "w1",
        stage: "ink",
        detail: "page 0 has new strokes here and on the hub",
        inkPageId: 0,
        local: body(10),
        server: body(20),
        localInk: [{ kind: "whiteboard", key: "w1", page_id: 0, updated_at: 10, gz: "span" }],
        serverInk: [{ kind: "whiteboard", key: "w1", page_id: 0, updated_at: 20, gz: "span" }],
      },
      { fetchPreviewInk },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchPreviewInk.mock.calls.map((call) => call[0])).toContain(1);
  });
});

describe("footnote rows, without opening the panel", () => {
  afterEach(() => {
    document.body.textContent = "";
  });

  /**
   * The same mark on both sides, each carrying its own note.
   *
   * That difference is the point: the live hub in the workspace reads *this*
   * device's footnotes, so it could only ever show one of the two. The merge
   * window lists those pieces as subentries instead of mounting the panel.
   */
  const BOTH: HubPadConflict = {
    ...WITH_INK,
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

  /** The ✓ / ✕ on one row, in one pane. */
  const tickRow = (side: 0 | 1, id: string, action: "keep" | "drop") => {
    const pane = document.querySelectorAll(".lc-hub-conflict-pane")[side]!;
    const row = pane.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!;
    act(() => {
      (row.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
    });
  };

  it("never opens the footnote panel from a row", () => {
    mount(BOTH);
    act(() => noteByText("kept here with new words").click());
    tickRow(0, "same", "keep");
    tickRow(1, "same", "keep");
    expect(document.querySelectorAll(".lc-footnote-overview")).toHaveLength(0);
    expect(noteByText("kept here with new words").className).toContain("is-focused");
  });

  it("lists each changed piece under the mark", () => {
    mount(BOTH);
    expect(noteByText("note from this device")).toBeTruthy();
    expect(noteByText("note from the other one")).toBeTruthy();
    expect(noteByText("note from this device").className).toContain("is-part");
  });

  it("lets a subentry be kept on its own", () => {
    mount(BOTH);
    tickRow(0, "same::notes:ln", "keep");
    const row = document.querySelectorAll(".lc-hub-conflict-pane")[0]!.querySelector(
      '[data-note-id="same::notes:ln"]',
    )!;
    expect(row.getAttribute("data-pick")).toBe("keep");
  });

  it("does not offer Keep Server for handwriting that could not be read", () => {
    mount({ ...WITH_INK, localInk: [], serverInk: null });
    const serverInk = inkRow(1);
    expect(serverInk.textContent).toContain("Could not read handwriting");
    const keep = serverInk.querySelector('[data-action="keep"]') as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
  });
});
