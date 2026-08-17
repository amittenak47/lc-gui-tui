/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { TabStrip } from "./TabStrip";
import {
  HOME_TAB_ID,
  homeTab,
  type AnnotateTab,
  type TabRecord,
  type WhiteboardTab,
} from "../util/tabs";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so the scroll-into-view on focus is a no-op stub.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

function board(id: string, title: string, dirty = false): WhiteboardTab {
  return { id, kind: "whiteboard", title, dirty, lastActive: 0, notebookId: "nb-1" };
}

function doc(id: string, title: string, indexed: AnnotateTab["indexed"] = "idle"): AnnotateTab {
  return {
    id,
    kind: "annotate",
    title,
    dirty: false,
    lastActive: 0,
    docId: "d-1",
    hash: "h-1",
    docType: "markdown",
    indexed,
  };
}

function mount(props: Partial<Parameters<typeof TabStrip>[0]> & { tabs: TabRecord[] }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const merged = {
    activeId: HOME_TAB_ID,
    onFocus: () => {},
    onClose: () => {},
    ...props,
  };
  act(() => {
    root.render(<TabStrip {...merged} />);
  });
  return {
    host,
    chips: () => Array.from(host.querySelectorAll<HTMLElement>(".lc-tab")),
    unmount: () => act(() => root.unmount()),
  };
}

describe("TabStrip", () => {
  it("draws every record, active one marked", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], activeId: "b1" });
    const chips = view.chips();
    expect(chips.map((chip) => chip.querySelector(".lc-tab-title")?.textContent)).toEqual([
      "Home",
      "doodle",
    ]);
    expect(chips[1]?.className).toContain("is-active");
    expect(chips[0]?.getAttribute("aria-selected")).toBe("false");
    view.unmount();
  });

  it("gives Home no close button and everything else one", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")] });
    expect(view.chips()[0]?.querySelector(".lc-tab-close")).toBeNull();
    expect(view.chips()[1]?.querySelector(".lc-tab-close")).not.toBeNull();
    view.unmount();
  });

  it("reports focus and close separately", () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onFocus, onClose });
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-hit")?.click();
    });
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-close")?.click();
    });
    expect(onFocus).toHaveBeenCalledWith("b1");
    expect(onClose).toHaveBeenCalledWith("b1");
    view.unmount();
  });

  it("stops taking taps while a workspace is opening", () => {
    const onFocus = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], busy: true, onFocus });
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-hit")?.click();
    });
    expect(onFocus).not.toHaveBeenCalled();
    view.unmount();
  });

  it("badges parked documents from the record and the live one from the chip", () => {
    const live = <span className="lc-doc-index-chip is-ok">indexed</span>;
    const view = mount({
      tabs: [homeTab(), doc("d1", "notes.md", "indexed"), doc("d2", "paper.pdf", "indexing")],
      activeId: "d1",
      activeIndexChip: live,
    });
    const chips = view.chips();
    // Active tab shows the real chip (it has the popover), parked shows the word.
    expect(chips[1]?.querySelector(".lc-doc-index-chip")?.className).toContain("is-ok");
    expect(chips[2]?.querySelector(".lc-doc-index-chip")?.textContent).toBe("indexing…");
    view.unmount();
  });

  it("keeps the index badge off kinds that are never embedded", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")] });
    expect(view.host.querySelectorAll(".lc-doc-index-chip")).toHaveLength(0);
    view.unmount();
  });

  it("marks unsaved work", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle", true)] });
    expect(view.chips()[1]?.querySelector(".lc-tab-dot")).not.toBeNull();
    expect(view.chips()[0]?.querySelector(".lc-tab-dot")).toBeNull();
    view.unmount();
  });
});
