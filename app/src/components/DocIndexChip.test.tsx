/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { DocIndexChip, type DocIndexChipProps } from "./DocIndexChip";

const hub = vi.hoisted(() => ({
  hub: { url: "http://desktop:7878", token: "token" },
  status: "online" as "online" | "offline" | "unknown",
}));
vi.mock("../util/padHubStatus", () => ({ usePadHubStatus: () => hub }));
const roots = new Set<ReturnType<typeof createRoot>>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hub.status = "online";
});

function mount(props: Partial<DocIndexChipProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  act(() =>
    root.render(
      <DocIndexChip status="indexed" meta={null} error={null} {...props} />,
    ),
  );
  const rerender = (next: Partial<DocIndexChipProps>) => act(() => root.render(
    <DocIndexChip status="indexed" meta={null} error={null} {...props} {...next} />,
  ));
  return { host, root, rerender };
}

/** The chip itself, ignoring the popover that portals to `document.body`. */
function chip(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".lc-doc-index-chip");
}

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.clear();
  document.body.textContent = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the chip while a Sync walk runs", () => {
  it("stops the ring, names failure, shows the reason and retries on one tap", () => {
    const onSync = vi.fn();
    const { host, rerender } = mount({ onSync, walkStage: "idle" });
    const button = host.querySelector(".lc-doc-index-sync") as HTMLButtonElement;
    act(() => button.click());
    expect(onSync).toHaveBeenCalledOnce();
    rerender({ walkError: "The hub has a newer copy of Algorithms." });
    expect(button.textContent).toContain("Sync failed");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.querySelector(".lc-doc-index-ring")).toBeNull();
    expect(button.querySelector('[aria-label="Sync error"]')).not.toBeNull();
    expect(document.querySelector(".lc-doc-sync-line")?.textContent).toContain("newer copy of Algorithms");
    act(() => button.click());
    expect(onSync).toHaveBeenCalledTimes(2);
  });

  it("closes the header progress overlay when the merge window takes over", () => {
    const { host, rerender } = mount({ onSync: vi.fn(), walkStage: "pad" });
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(document.querySelector(".lc-doc-sync-pop")).not.toBeNull();
    rerender({ walkWaiting: "conflict" });
    expect(document.querySelector(".lc-doc-sync-pop")).toBeNull();
    expect(host.querySelector(".lc-doc-index-ring")).toBeNull();
  });
  it("says which stage, for the stages that name themselves", () => {
    // A tap used to walk the pill through Index → Pad → Ink → Links → Pull
    // while the tab said `indexed` the whole way.
    for (const stage of ["pad", "ink", "links", "pull"]) {
      const { host, root } = mount({ walkStage: stage });
      expect(chip(host)?.textContent).toContain(`${stage}…`);
      expect(chip(host)?.className).toContain("is-working");
      act(() => root.unmount());
    }
  });

  it("names the job for Index, which holds two of them", () => {
    const extract = mount({ walkStage: "index", walkJob: "extract" });
    expect(chip(extract.host)?.textContent).toContain("indexing…");
    act(() => extract.root.unmount());

    const embed = mount({ walkStage: "index", walkJob: "embed" });
    expect(chip(embed.host)?.textContent).toContain("embedding…");
    act(() => embed.root.unmount());
  });

  it("keeps saying indexing while the pill is on Index, even with no job", () => {
    /*
     * The ping before extract, and the PUT after the last page, both report
     * Index with no job. Falling through to `indexed` made the tab look done
     * while the button was still on Index.
     */
    const { host } = mount({ status: "indexed", walkStage: "index", walkJob: null });
    expect(chip(host)?.textContent).toContain("indexing…");
    expect(chip(host)?.className).toContain("is-working");
  });

  it("counts where there is a count and sweeps where there is not", () => {
    const counted = mount({
      walkStage: "index",
      walkJob: "embed",
      walkProgress: { done: 3, total: 4 },
    });
    expect(counted.host.querySelector(".lc-doc-index-ring-pct")?.textContent).toBe("75");
    act(() => counted.root.unmount());

    const complete = mount({
      walkStage: "index",
      walkJob: "extract",
      walkProgress: { done: 4, total: 4 },
    });
    expect(complete.host.querySelector(".lc-doc-index-ring-pct")).toBeNull();
    expect(complete.host.querySelector(".is-sweeping")).not.toBeNull();
    expect(chip(complete.host)?.textContent).toContain("indexing…");
    act(() => complete.root.unmount());

    const swept = mount({ walkStage: "links" });
    expect(swept.host.querySelector(".lc-doc-index-ring-pct")).toBeNull();
    expect(swept.host.querySelector(".is-sweeping")).not.toBeNull();
  });

    it("says choose copy with no sweep while the walk waits on a conflict", () => {
      const { host } = mount({ walkStage: "pad", walkWaiting: "conflict" });
      expect(chip(host)?.textContent).toContain("choose copy");
      expect(chip(host)?.className).not.toContain("is-working");
      expect(host.querySelector(".lc-doc-index-ring")).toBeNull();
    });

    it("says why a walk parked, not only the stage", () => {
      const { host } = mount({ walkStage: "index", walkError: "hub unreachable" });
      expect(chip(host)?.textContent).toContain("hub unreachable");
      expect(chip(host)?.className).toContain("is-bad");
      expect(host.querySelector(".lc-doc-index-ring")).toBeNull();
    });

  it("finishes on synced, not indexed", () => {
    const { host } = mount({ status: "indexed", walkStage: "synced" });
    expect(chip(host)?.textContent).toContain("synced");
    expect(chip(host)?.textContent).not.toContain("indexed");
    expect(chip(host)?.className).not.toContain("is-working");
  });

  it("says synced on a whiteboard that has no index card", () => {
    const { host } = mount({ status: "idle", onIndex: null, walkStage: "synced" });
    expect(chip(host)?.textContent).toContain("synced");
    expect(chip(host)).not.toBeNull();
  });

  it("says not synced when the pad has local edits", () => {
    const { host } = mount({ status: "idle", onIndex: null, padSync: "not-synced" });
    expect(chip(host)?.textContent).toContain("not synced");
  });

  it("says not synced on an indexed file whose pad is dirty", () => {
    const { host } = mount({ status: "indexed", padSync: "not-synced" });
    expect(chip(host)?.textContent).toContain("not synced");
    expect(chip(host)?.textContent).not.toContain("indexed");
  });

  it("shows Sync alone for pad status without opening an index card", () => {
    const onSync = vi.fn();
    const { host } = mount({
      status: "idle",
      onIndex: null,
      padSync: "not-synced",
      onSync,
    });
    const sync = host.querySelector(".lc-doc-index-sync") as HTMLButtonElement;
    expect(sync).not.toBeNull();
    expect(chip(host)).toBeNull();
    expect(sync.getAttribute("aria-label")).toBe("Hub sync");
    act(() => sync.click());
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Index this document");
  });

  it("opens the Sync overlay before the index card", () => {
    const onSync = vi.fn();
    const { host } = mount({ status: "indexed", onSync });
    const sync = host.querySelector(".lc-doc-index-sync") as HTMLButtonElement;
    expect(sync).not.toBeNull();
    act(() => sync.click());
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(chip(host)).toBeNull();
    expect(document.querySelector(".lc-doc-sync-pop")).not.toBeNull();
    expect(document.querySelector(".lc-doc-index-pop")?.classList.contains("is-open")).toBe(false);
  });

  it("sweeps on the tab while the viewport ink is still landing", () => {
    const { host } = mount({ status: "idle", onIndex: null, viewportWait: true });
    expect(chip(host)?.className).toContain("is-working");
  });
});

function syncButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(".lc-doc-index-sync")!;
}

function syncPopover(): HTMLElement | null {
  return document.querySelector(".lc-doc-sync-pop");
}

describe("the in-tab Sync overlay", () => {
  it.each([
    { walkStage: "pad" },
    { walkStage: "synced" },
    { padSync: "not-synced" as const },
    { status: "indexed" as const },
    { status: "error" as const, error: "index failed" },
    { walkStage: "pad", walkError: "hub unreachable" },
    { status: "indexing" as const },
    { embedding: true },
    { status: "idle" as const },
    { viewportWait: true },
  ])("renders only the Sync box in the tab: %j", (state) => {
    const { host } = mount({ ...state, onSync: vi.fn() });
    expect(chip(host)).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(syncButton(host).textContent).toBe(state.walkError ? "!Sync failed" : "Sync");
    expect(syncButton(host).disabled).toBe(false);
    expect(syncButton(host).getAttribute("aria-label")).toBe(state.walkError ? "Sync failed" : "Hub sync");
    expect(syncButton(host).getAttribute("aria-haspopup")).toBe("dialog");
    expect(syncButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["online", "unknown"] as const)("starts once and toggles the overlay when %s", (status) => {
    hub.status = status;
    const onSync = vi.fn();
    const { host, rerender } = mount({ walkStage: "idle", onSync });
    act(() => syncButton(host).click());
    expect(onSync).toHaveBeenCalledTimes(1);
    rerender({ walkStage: "index", walkJob: "embed" });
    expect(syncPopover()?.querySelector(".lc-doc-sync-line")?.textContent).toBe("embedding…");
    expect(syncPopover()?.getAttribute("role")).toBe("status");
    expect(syncPopover()?.getAttribute("aria-live")).toBe("polite");
    expect(syncButton(host).getAttribute("aria-expanded")).toBe("true");
    act(() => syncButton(host).click());
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(syncPopover()).toBeNull();
    expect(syncButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens during an existing walk without starting it again or auto-closing", () => {
    vi.useFakeTimers();
    const onSync = vi.fn();
    const { host, rerender } = mount({ walkStage: "pull", onSync });
    act(() => syncButton(host).click());
    expect(onSync).not.toHaveBeenCalled();
    expect(syncPopover()?.querySelector(".lc-doc-sync-line")?.textContent).toBe("pull…");
    rerender({ walkStage: "synced" });
    act(() => vi.advanceTimersByTime(5_000));
    expect(syncPopover()).not.toBeNull();
  });

  it("shows the offline message without starting a walk and stays open", () => {
    vi.useFakeTimers();
    hub.status = "offline";
    const onSync = vi.fn();
    const { host } = mount({ walkStage: "synced", onSync });
    act(() => syncButton(host).click());
    expect(onSync).not.toHaveBeenCalled();
    expect(syncPopover()?.querySelector(".lc-doc-sync-line")?.textContent)
      .toBe("Desktop app is offline — changes will sync when it's back.");
    act(() => vi.advanceTimersByTime(10_000));
    expect(syncPopover()).not.toBeNull();
  });

  it.each([
    [{ status: "indexed" }, "indexed"],
    [{ status: "indexed", meta: { embedded: false } }, "indexed · words"],
    [{ status: "idle", onIndex: vi.fn() }, "not indexed"],
  ] as const)("opens the index card from the index row: %j", (state, text) => {
    const props = state as Partial<DocIndexChipProps>;
    const { host } = mount({ ...props, onSync: vi.fn() });
    const sync = syncButton(host);
    vi.spyOn(sync, "getBoundingClientRect").mockReturnValue({ bottom: 40, left: 20 } as DOMRect);
    act(() => sync.click());
    const row = syncPopover()?.querySelector<HTMLButtonElement>("button.lc-doc-sync-index");
    expect(row?.textContent).toBe(text);
    expect(syncPopover()?.style.top).toBe("48px");
    act(() => row!.click());
    expect(syncPopover()).toBeNull();
    const card = document.querySelector<HTMLElement>(".lc-doc-index-pop.is-open");
    expect(card).not.toBeNull();
    expect(card?.style.top).toBe("48px");
    expect(card?.style.left).toBe("20px");
    if (props.onIndex) expect(props.onIndex).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "indexing", indexProgress: { done: 1, total: 4 } }, "25indexing…"],
    [{ status: "idle", embedding: true, embedProgress: { done: 2, total: 4 } }, "50embedding…"],
    [{ status: "error", error: "extract failed" }, "index error"],
  ] as const)("uses a non-button index row when canOpen is false: %j", (state, text) => {
    const { host } = mount({ ...state, onSync: vi.fn() });
    act(() => syncButton(host).click());
    const row = syncPopover()?.querySelector(".lc-doc-sync-index");
    expect(row?.tagName).toBe("DIV");
    expect(row?.textContent).toBe(text);
    if (state.status === "error") expect(row?.getAttribute("title")).toBe("extract failed");
  });

  it("omits the index row when there is no index state to offer", () => {
    const { host } = mount({ status: "idle", onSync: vi.fn() });
    act(() => syncButton(host).click());
    expect(syncPopover()?.querySelector(".lc-doc-sync-index")).toBeNull();
  });

  it.each(["walk", "pad"])("closes 2.5 seconds after %s lands synced", (landing) => {
    vi.useFakeTimers();
    const { host, rerender } = mount({ onSync: vi.fn() });
    act(() => syncButton(host).click());
    rerender({ walkStage: "pad" });
    act(() => vi.advanceTimersByTime(10_000));
    expect(syncPopover()).not.toBeNull();
    rerender(landing === "walk" ? { walkStage: "synced" } : { walkStage: "idle", padSync: "synced" });
    expect(syncPopover()?.querySelector(".lc-doc-sync-line")?.textContent).toBe("synced");
    act(() => vi.advanceTimersByTime(2_499));
    expect(syncPopover()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(syncPopover()).toBeNull();
  });

  it("waits for the newly started walk rather than a previous synced state", () => {
    vi.useFakeTimers();
    const { host, rerender } = mount({ walkStage: "synced", padSync: "synced", onSync: vi.fn() });
    act(() => syncButton(host).click());
    act(() => vi.advanceTimersByTime(5_000));
    expect(syncPopover()).not.toBeNull();
    rerender({ walkStage: "pad" });
    rerender({ walkStage: "synced" });
    act(() => vi.advanceTimersByTime(2_500));
    expect(syncPopover()).toBeNull();
  });

  it.each([
    [{ walkError: "hub unreachable", walkStage: "synced" }, "hub unreachable"],
    [{ walkStage: "idle", padSync: "not-synced" }, "not synced"],
  ] as const)("keeps the overlay open on a parked walk: %j", (state, text) => {
    vi.useFakeTimers();
    const { host, rerender } = mount({ onSync: vi.fn() });
    act(() => syncButton(host).click());
    rerender({ walkStage: "pad" });
    rerender(state);
    act(() => vi.advanceTimersByTime(10_000));
    expect(syncPopover()?.querySelector(".lc-doc-sync-line")?.textContent).toBe(text);
  });

  it("cancels a pending auto-close when a walk errors", () => {
    vi.useFakeTimers();
    const { host, rerender } = mount({ onSync: vi.fn() });
    act(() => syncButton(host).click());
    rerender({ walkStage: "synced" });
    act(() => vi.advanceTimersByTime(1_000));
    rerender({ walkStage: "synced", walkError: "upload failed" });
    act(() => vi.advanceTimersByTime(10_000));
    expect(syncPopover()?.textContent).toContain("upload failed");
  });

  it.each([
    { walkStage: "pad", walkProgress: { done: 1, total: 4 } },
    { status: "indexing" as const, indexProgress: { done: 1, total: 4 } },
    { embedding: true, embedProgress: { done: 1, total: 4 } },
  ])("replaces the hub dot with the working ring: %j", (state) => {
    const { host, rerender } = mount({ ...state, onSync: vi.fn() });
    expect(syncButton(host).querySelector(".lc-doc-index-ring")).not.toBeNull();
    expect(syncButton(host).querySelector(".lc-doc-index-ring-pct")?.textContent).toBe("25");
    expect(syncButton(host).querySelector(".lc-hub-status-dot")).toBeNull();
    rerender({ walkStage: "synced", status: "indexed", embedding: false });
    expect(syncButton(host).querySelector(".lc-doc-index-ring")).toBeNull();
    expect(syncButton(host).querySelector(".lc-hub-status-dot")).not.toBeNull();
  });

  it("sweeps with unmeasured progress and marks error and conflict states", () => {
    const { host, rerender } = mount({ walkStage: "pad", onSync: vi.fn() });
    expect(syncButton(host).querySelector(".is-sweeping")).not.toBeNull();
    rerender({ walkError: "upload failed" });
    expect(syncButton(host).classList.contains("is-bad")).toBe(true);
    expect(syncButton(host).title).toBe("upload failed");
    rerender({ walkWaiting: "conflict" });
    expect(syncButton(host).classList.contains("is-attention")).toBe(true);
    expect(syncButton(host).title).toBe("Both copies changed — pick which stays.");
  });

  it("closes on outside pointerdown or Escape, and ignores pointerdown inside", () => {
    const { host } = mount({ onSync: vi.fn() });
    act(() => syncButton(host).click());
    act(() => syncPopover()!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(syncPopover()).not.toBeNull();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(syncPopover()).toBeNull();
    act(() => syncButton(host).click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(syncPopover()).toBeNull();
  });
});

describe("the original chip without a hub sync action", () => {
  it.each([
    [{ walkStage: "synced" }, "BUTTON", "lc-doc-index-chip is-ok", "synced"],
    [{ status: "indexed" }, "BUTTON", "lc-doc-index-chip is-ok", "indexed"],
    [{ status: "indexing", indexProgress: { done: 1, total: 4 } }, "SPAN", "lc-doc-index-chip is-working", "25indexing…"],
    [{ status: "error", error: "index failed" }, "SPAN", "lc-doc-index-chip is-bad", "index failed"],
  ] as const)("preserves the chip output for %j", (state, tag, classes, text) => {
    const { host } = mount(state);
    expect(chip(host)?.tagName).toBe(tag);
    expect(chip(host)?.className).toBe(classes);
    expect(chip(host)?.textContent).toBe(text);
    expect(host.querySelector(".lc-doc-index-sync")).toBeNull();
    expect(syncPopover()).toBeNull();
    if (tag === "BUTTON") {
      act(() => (chip(host) as HTMLButtonElement).click());
      expect(document.querySelector(".lc-doc-index-pop.is-open")).not.toBeNull();
    }
  });
});

describe("the chip at rest", () => {
  it("is not a one-click Index", () => {
    /*
     * `idle` with an `onIndex` used to be a button that indexed on the spot,
     * from the strip — the one place a tab chip did work rather than reporting
     * it. The work moved into the card behind it.
     */
    const onIndex = vi.fn();
    const { host } = mount({ status: "idle", onIndex });
    const button = chip(host) as HTMLButtonElement;
    expect(button.textContent).toContain("not indexed");
    act(() => button.click());
    expect(onIndex).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Index this document");
  });

  it("indexes from inside the card", () => {
    const onIndex = vi.fn();
    const { host } = mount({ status: "idle", onIndex });
    act(() => (chip(host) as HTMLButtonElement).click());
    const action = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Index this document",
    )!;
    act(() => action.click());
    expect(onIndex).toHaveBeenCalledTimes(1);
  });

  it("says why, rather than offering, when indexing is blocked", () => {
    const onIndex = vi.fn();
    const { host } = mount({
      status: "idle",
      onIndex,
      blocked: "freeze this page first",
    });
    act(() => (chip(host) as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("freeze this page first");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === "Index this document",
      ),
    ).toBe(false);
  });

  it("stays absent when there is nothing to offer", () => {
    const { host } = mount({ status: "idle", onIndex: null });
    expect(chip(host)).toBeNull();
  });
});
