/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { DocIndexChip, type DocIndexChipProps } from "./DocIndexChip";

function mount(props: Partial<DocIndexChipProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DocIndexChip status="indexed" meta={null} error={null} {...props} />,
    ),
  );
  return { host, root };
}

/** The chip itself, ignoring the popover that portals to `document.body`. */
function chip(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".lc-doc-index-chip");
}

afterEach(() => {
  document.body.textContent = "";
});

describe("the chip while a Sync walk runs", () => {
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

  it("shows nothing extra for an Index stage that skipped both jobs", () => {
    /*
     * The hub already holding the text index says nothing about embeddings,
     * and a configured-model skip ends embedding without touching the index.
     * With neither running there is nothing to report, and a bare "index…"
     * between two skips would be a flash saying nothing.
     */
    const { host } = mount({ status: "indexed", walkStage: "index", walkJob: null });
    expect(chip(host)?.textContent).toContain("indexed");
    expect(chip(host)?.className).not.toContain("is-working");
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

  it("says where a walk parked, without a ring", () => {
    const { host } = mount({ walkStage: "pad", walkError: "hub unreachable" });
    expect(chip(host)?.textContent).toContain("pad error");
    expect(chip(host)?.className).toContain("is-bad");
    expect(host.querySelector(".lc-doc-index-ring")).toBeNull();
  });

  it("finishes on synced, not indexed", () => {
    const { host } = mount({ status: "indexed", walkStage: "synced" });
    expect(chip(host)?.textContent).toContain("synced");
    expect(chip(host)?.textContent).not.toContain("indexed");
    expect(chip(host)?.className).not.toContain("is-working");
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
