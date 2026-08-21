/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { TabStrip } from "./TabStrip";
import {
  HOME_TAB_ID,
  homeTab,
  type AnnotateTab,
  type TabGroup,
  type TabRecord,
  type WhiteboardTab,
} from "../util/tabs";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so the scroll-into-view on focus is a no-op stub.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  // jsdom ships no pointer capture, and the drag holds one for its whole life.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () {
      return true;
    };
  }
});

afterEach(() => {
  vi.useRealTimers();
});

/** A pointer event jsdom will carry — it has no PointerEvent of its own. */
function pointer(type: string, init: { x: number; y: number; type?: string; button?: number }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: init.x,
    clientY: init.y,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: init.type ?? "mouse" });
  return event;
}

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
    source: null,
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
    rerender: (next: Partial<Parameters<typeof TabStrip>[0]> & { tabs: TabRecord[] }) => {
      act(() => {
        root.render(<TabStrip {...merged} {...next} />);
      });
    },
    rightClick: (title: string) => {
      const chip = Array.from(host.querySelectorAll<HTMLElement>(".lc-tab")).find(
        (entry) => entry.querySelector(".lc-tab-title")?.textContent === title,
      );
      act(() => {
        chip
          ?.querySelector(".lc-tab-hit")
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      });
    },
    menuItems: () =>
      Array.from(document.querySelectorAll<HTMLElement>(".lc-tab-menu button")).map(
        (entry) => entry.textContent,
      ),
    menuItem: (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".lc-tab-menu button")).find(
        (entry) => entry.textContent === label,
      ),
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

  it("still reports Home focus when Home is already the active chip", () => {
    const onFocus = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onFocus });
    act(() => {
      view.chips()[0]?.querySelector<HTMLButtonElement>(".lc-tab-hit")?.click();
    });
    expect(onFocus).toHaveBeenCalledWith(HOME_TAB_ID);
    view.unmount();
  });

  it("still takes taps while a workspace is opening", () => {
    /*
     * Waiting for a page is the moment you most want to go and read something
     * else. Workspaces stay mounted, so the load is still running when you come
     * back — there is nothing to protect by locking the strip.
     */
    const onFocus = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], busy: true, onFocus });
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-hit")?.click();
    });
    expect(onFocus).toHaveBeenCalledWith("b1");
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

  it("shows Home as an icon, with no title text and no close button", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], activeId: "b1" });
    const home = view.chips()[0]!;
    /*
     * Home is a landmark, not a document: it keeps the house and gives its
     * share of the strip back to the files you actually have open. The title is
     * hidden in CSS, so what has to be true here is that the glyph is rendered
     * and that nothing offers to close it.
     */
    expect(home.getAttribute("data-tab-kind")).toBe("home");
    expect(home.querySelector(".lc-tab-glyph")).not.toBeNull();
    expect(home.querySelector(".lc-tab-title")?.textContent).toBe("Home");
    expect(home.querySelector(".lc-tab-close")).toBeNull();
    view.unmount();
  });

  it("gives Home a row of its own, so the row can shrink with it", () => {
    /*
     * Making the tab compact was only half of it. Every `.lc-tab-row` takes an
     * equal share of the strip, so an icon-sized Home sat at the left of a row
     * still claiming a document's worth of width — a wide empty gap that read
     * as Home having disappeared rather than having got smaller.
     *
     * The CSS shrinks that row with `:has(> .lc-tab[data-tab-kind="home"])`,
     * which needs Home to be a *direct child* of a row it does not share.
     */
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], activeId: "b1" });
    const home = view.chips()[0]!;
    const row = home.parentElement!;
    expect(row.classList.contains("lc-tab-row")).toBe(true);
    expect(row.classList.contains("is-group")).toBe(false);
    expect(row.querySelectorAll(":scope > .lc-tab")).toHaveLength(1);
    expect(row.querySelector(':scope > .lc-tab[data-tab-kind="home"]')).not.toBeNull();
    view.unmount();
  });

  it("keeps saying Home while a workspace opens, and going there drops the load", () => {
    const onCancelLoad = vi.fn();
    const onFocus = vi.fn();
    const view = mount({
      tabs: [homeTab(), board("b1", "doodle")],
      activeId: "b1",
      busy: true,
      onFocus,
      onCancelLoad,
    });
    // Same number of chips, same slot — nothing shifts for the length of a load.
    expect(view.chips()).toHaveLength(2);
    const home = view.chips()[0]!;
    /*
     * It used to relabel itself "Cancel" for the duration. That renamed the one
     * fixed landmark in the strip at exactly the moment someone wants it, and
     * offered a second way to say "stop" next to the tab's own close button.
     * Home is a place; going there is what abandons the load.
     */
    expect(home.querySelector(".lc-tab-title")?.textContent).toBe("Home");
    act(() => {
      home.querySelector<HTMLButtonElement>(".lc-tab-hit")?.click();
    });
    expect(onCancelLoad).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(HOME_TAB_ID);
    view.unmount();
  });

  it("marks unsaved work", () => {
    const view = mount({ tabs: [homeTab(), board("b1", "doodle", true)] });
    expect(view.chips()[1]?.querySelector(".lc-tab-dot")).not.toBeNull();
    expect(view.chips()[0]?.querySelector(".lc-tab-dot")).toBeNull();
    view.unmount();
  });

  describe("drag to split", () => {
    function grab(view: ReturnType<typeof mount>, title: string) {
      return Array.from(view.host.querySelectorAll<HTMLElement>(".lc-tab"))
        .find((chip) => chip.querySelector(".lc-tab-title")?.textContent === title)!
        .querySelector<HTMLElement>(".lc-tab-hit")!;
    }

    it("carries a chip under the pointer and drops it on the board", () => {
      const onTabDrag = vi.fn();
      const onTabDrop = vi.fn();
      const onFocus = vi.fn();
      const view = mount({
        tabs: [homeTab(), board("b1", "doodle")],
        onTabDrag,
        onTabDrop,
        onFocus,
      });
      const hit = grab(view, "doodle");

      act(() => {
        hit.dispatchEvent(pointer("pointerdown", { x: 100, y: 20 }));
      });
      // Under the slop threshold this is still a press, not a drag.
      act(() => {
        hit.dispatchEvent(pointer("pointermove", { x: 103, y: 22 }));
      });
      expect(onTabDrag).not.toHaveBeenCalled();
      expect(document.querySelector(".lc-tab-ghost")).toBeNull();

      act(() => {
        hit.dispatchEvent(pointer("pointermove", { x: 300, y: 400 }));
      });
      expect(onTabDrag).toHaveBeenCalledWith("b1", 300, 400);
      // The ghost is what makes the gesture visible while it is happening.
      expect(document.querySelector(".lc-tab-ghost")?.textContent).toBe("doodle");
      expect(view.chips()[1]?.className).toContain("is-carrying");

      act(() => {
        hit.dispatchEvent(pointer("pointerup", { x: 300, y: 400 }));
      });
      expect(onTabDrop).toHaveBeenCalledWith("b1", 300, 400);
      expect(document.querySelector(".lc-tab-ghost")).toBeNull();
      // A drag that ends on the board must not also read as a click.
      act(() => {
        hit.click();
      });
      expect(onFocus).not.toHaveBeenCalled();
      view.unmount();
    });

    it("groups when a chip is dropped onto another chip", () => {
      const onTabDropOnTab = vi.fn();
      const view = mount({
        tabs: [homeTab(), board("b1", "doodle"), board("b2", "notes")],
        onTabDropOnTab,
      });
      const doodle = grab(view, "doodle");
      const notesChip = Array.from(view.host.querySelectorAll<HTMLElement>(".lc-tab")).find(
        (chip) => chip.querySelector(".lc-tab-title")?.textContent === "notes",
      )!;
      vi.spyOn(notesChip, "getBoundingClientRect").mockReturnValue({
        x: 200,
        y: 0,
        left: 200,
        top: 0,
        right: 280,
        bottom: 32,
        width: 80,
        height: 32,
        toJSON() {
          return {};
        },
      });
      act(() => {
        doodle.dispatchEvent(pointer("pointerdown", { x: 100, y: 20 }));
        doodle.dispatchEvent(pointer("pointermove", { x: 240, y: 16 }));
        doodle.dispatchEvent(pointer("pointerup", { x: 240, y: 16 }));
      });
      expect(onTabDropOnTab).toHaveBeenCalledWith("b1", "b2");
      view.unmount();
    });

    it("leaves Home where it is", () => {
      const onTabDrag = vi.fn();
      const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onTabDrag });
      const hit = grab(view, "Home");
      act(() => {
        hit.dispatchEvent(pointer("pointerdown", { x: 40, y: 20 }));
        hit.dispatchEvent(pointer("pointermove", { x: 300, y: 400 }));
      });
      expect(onTabDrag).not.toHaveBeenCalled();
      expect(document.querySelector(".lc-tab-ghost")).toBeNull();
      view.unmount();
    });

    it("drops the ghost when the pointer is taken away", () => {
      const onTabDragEnd = vi.fn();
      const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onTabDragEnd });
      const hit = grab(view, "doodle");
      act(() => {
        hit.dispatchEvent(pointer("pointerdown", { x: 100, y: 20 }));
        hit.dispatchEvent(pointer("pointermove", { x: 300, y: 400 }));
      });
      expect(document.querySelector(".lc-tab-ghost")).not.toBeNull();
      act(() => {
        hit.dispatchEvent(pointer("pointercancel", { x: 300, y: 400 }));
      });
      expect(document.querySelector(".lc-tab-ghost")).toBeNull();
      expect(onTabDragEnd).toHaveBeenCalled();
      view.unmount();
    });

    it("lets a touch hold stay a drag, and ignores the long-press context menu", () => {
      const onTabDrag = vi.fn();
      const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onTabDrag });
      const hit = grab(view, "doodle");

      act(() => {
        hit.dispatchEvent(pointer("pointerdown", { x: 100, y: 20, type: "touch" }));
        hit.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      });
      expect(view.menuItems()).toEqual([]);

      act(() => {
        hit.dispatchEvent(pointer("pointermove", { x: 300, y: 400, type: "touch" }));
      });
      expect(onTabDrag).toHaveBeenCalledWith("b1", 300, 400);
      expect(document.querySelector(".lc-tab-ghost")).not.toBeNull();
      expect(view.menuItems()).toEqual([]);
      act(() => {
        hit.dispatchEvent(pointer("pointerup", { x: 300, y: 400, type: "touch" }));
      });
      view.unmount();
    });
  });

  it("closes a tab that is not Home", () => {
    const onClose = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], onClose });
    // Home has no close button — you cannot close the place you land.
    expect(view.chips()[0]?.querySelector(".lc-tab-close")).toBeNull();
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-close")?.click();
    });
    expect(onClose).toHaveBeenCalledWith("b1");
    view.unmount();
  });

  it("stays closable while another tab is loading", () => {
    const onClose = vi.fn();
    const view = mount({ tabs: [homeTab(), board("b1", "doodle")], busy: true, onClose });
    act(() => {
      view.chips()[1]?.querySelector<HTMLButtonElement>(".lc-tab-close")?.click();
    });
    expect(onClose).toHaveBeenCalledWith("b1");
    view.unmount();
  });

  describe("groups", () => {
    const pair: TabGroup = {
      id: "g1",
      children: ["b2", "b1"],
      split: { axis: "vertical", ratio: 0.5 },
    };

    function grouped(id: string, title: string): WhiteboardTab {
      return { ...board(id, title), group: "g1" };
    }

    it("draws a split's chips side by side, in the group's order", () => {
      // `b1` and `b2` are not neighbours in the tab order, and the group lists
      // them the other way round — the strip follows the group, not the order.
      const view = mount({
        tabs: [homeTab(), grouped("b1", "left"), board("b3", "loose"), grouped("b2", "right")],
        groups: [pair],
      });
      expect(view.chips().map((chip) => chip.querySelector(".lc-tab-title")?.textContent)).toEqual([
        "Home",
        "right",
        "left",
        "loose",
      ]);
      const rows = Array.from(view.host.querySelectorAll(".lc-tab-row"));
      // Home, the pair, and the loose tab — three rows, one of them a group.
      expect(rows).toHaveLength(3);
      const group = view.host.querySelector(".lc-tab-row.is-group");
      expect(group?.querySelectorAll(".lc-tab")).toHaveLength(2);
      expect(group?.querySelector(".lc-tab-group-frame")).not.toBeNull();
      view.unmount();
    });

    it("drops the frame when the group disbands", () => {
      const view = mount({
        tabs: [homeTab(), grouped("b1", "left"), grouped("b2", "right")],
        groups: [pair],
      });
      expect(view.host.querySelector(".lc-tab-row.is-group")).not.toBeNull();
      view.rerender({ tabs: [homeTab(), board("b1", "left"), board("b2", "right")], groups: [] });
      expect(view.host.querySelector(".lc-tab-row.is-group")).toBeNull();
      expect(view.chips()).toHaveLength(3);
      view.unmount();
    });

    it("offers Unsplit for a grouped tab and Split for a loose one", () => {
      const onSplitWithActive = vi.fn();
      const onUnsplit = vi.fn();
      const view = mount({
        tabs: [homeTab(), grouped("b1", "left"), grouped("b2", "right"), board("b3", "loose")],
        groups: [pair],
        groupedIds: ["b1", "b2"],
        activeId: "b1",
        onSplitWithActive,
        onUnsplit,
      });

      // A tab already in a split can only leave it.
      view.rightClick("left");
      expect(view.menuItems()).toEqual(["Unsplit", "Close"]);
      act(() => {
        view.menuItem("Unsplit")?.click();
      });
      expect(onUnsplit).toHaveBeenCalledWith("b1");
      // Acting closes the menu — it is pinned to a point that is now stale.
      expect(view.menuItems()).toEqual([]);

      // A loose tab can join the one on screen, side by side.
      view.rightClick("loose");
      expect(view.menuItems()).toEqual(["Split", "Close"]);
      act(() => {
        view.menuItem("Split")?.click();
      });
      expect(onSplitWithActive).toHaveBeenCalledWith("b3", "right");
      view.unmount();
    });

    it("will not split the open tab with itself", () => {
      const view = mount({
        tabs: [homeTab(), board("b1", "doodle")],
        activeId: "b1",
        onSplitWithActive: () => {},
      });
      view.rightClick("doodle");
      // Splitting needs two panes, and this tab is already the only one.
      expect(view.menuItem("Split")?.disabled).toBe(true);
      expect(view.menuItem("Close")?.disabled).toBe(false);
      view.unmount();
    });

    it("keeps its menu off Home", () => {
      const view = mount({ tabs: [homeTab(), board("b1", "doodle")] });
      view.rightClick("Home");
      // Home is not a pane, so it has nothing to split and nothing to close.
      expect(view.menuItems()).toEqual([]);
      view.unmount();
    });

    it("survives a group naming a tab that is already gone", () => {
      // Closing one half before the reducer drops the group must not blank the
      // strip — the missing child is skipped, the survivor still draws.
      const view = mount({ tabs: [homeTab(), grouped("b1", "left")], groups: [pair] });
      expect(view.chips().map((chip) => chip.querySelector(".lc-tab-title")?.textContent)).toEqual([
        "Home",
        "left",
      ]);
      view.unmount();
    });
  });
});
