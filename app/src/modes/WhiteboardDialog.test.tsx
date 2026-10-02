/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { LIBRARY_HOLD_MS } from "../util/gesture";
import type { WhiteboardNotebookMeta } from "../util/whiteboardStore";

const live = vi.hoisted(() => ({ rows: [] as WhiteboardNotebookMeta[] }));
const trash = vi.hoisted(() => ({ rows: [] as WhiteboardNotebookMeta[] }));
const snapshots = vi.hoisted(() => ({ rows: [] as Array<{kind: string; key: string; tier: string; writtenAt: number; name: string}> }));

vi.mock("../util/whiteboardStore", () => ({
  WHITEBOARD_LIBRARY_EVENT: "lc-whiteboard-library",
  listWhiteboardNotebooks: () => live.rows,
  listWhiteboardTrash: () => trash.rows,
  deleteWhiteboardNotebook: vi.fn(),
  setWhiteboardNotebookLocked: vi.fn(),
}));

vi.mock("../util/padSnapshotStore", () => ({
  listPadSnapshots: async () => snapshots.rows,
  PAD_SNAPSHOT_TIERS: [{id:"2h", label:"2 hours"}, {id:"24h", label:"24 hours"}, {id:"7d", label:"7 days"}],
}));

vi.mock("../util/padSync", () => ({
  TOMBSTONE_COPY: "Trash on this device — three days, then gone.",
}));

import { WhiteboardDialog, type WhiteboardDialogProps } from "./WhiteboardDialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () {
      return true;
    };
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    // @ts-expect-error jsdom lacks PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
});

beforeEach(() => {
  live.rows = [
    { id: "w1", title: "One", updatedAt: 1, pageCount: 1 },
  ];
  trash.rows = [{ id: "w2", title: "Trashed", updatedAt: 1, pageCount: 1, deletedAt: 2 }];
  snapshots.rows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function meta(partial: Partial<WhiteboardNotebookMeta> & { id: string; title: string }): WhiteboardNotebookMeta {
  return { updatedAt: 1, pageCount: 1, ...partial };
}

function mount(props: Partial<WhiteboardDialogProps> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  let current = { mode: "entry", onChoose, onCancel, ...props } as WhiteboardDialogProps;
  act(() => { root.render(<WhiteboardDialog {...current} />); });
  return {
    host,
    onChoose,
    onCancel,
    update: (next: Partial<WhiteboardDialogProps>) => act(() => {
      current = { ...current, ...next } as WhiteboardDialogProps;
      root.render(<WhiteboardDialog {...current} />);
    }),
    unmount: () => act(() => root.unmount()),
  };
}

function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function hold(label: string, host: HTMLElement) {
  if (label === "Load") await hold("Open", host);
  const aria = `Hold to confirm: ${label}`;
  const button = Array.from(host.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === aria,
  );
  expect(button, `missing hold button "${aria}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LIBRARY_HOLD_MS + 50));
  });
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
}

async function tap(label: string, host: HTMLElement) {
  const aria = `${label}: tap to edit, hold to confirm`;
  const button = Array.from(host.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === aria,
  );
  expect(button, `missing tap button "${aria}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
}

describe("WhiteboardDialog", () => {
  it("uses the PDF's square shell, row subtext and no footer hint, with existing actions at the top level", async () => {
    live.rows[0].hubAckUpdatedAt = 1;
    const view = mount({ allowSave: true, snapshotKey: "w1", defaultName: "One", onRefreshHub: vi.fn() });
    try {
      expect(view.host.querySelector('[role="dialog"]')?.getAttribute("data-dialog-shape")).toBe("blocky");
      expect(view.host.textContent).toContain("Start a blank notebook");
      expect(view.host.textContent).toContain("Pick a notebook from the library");

      expect(view.host.querySelector(".lc-whiteboard-context-title")?.textContent).toBe("One");
      expect(view.host.querySelector(".lc-whiteboard-context-sync")?.textContent).toBe("synced");
      view.update({ dirty: true });
      expect(view.host.querySelector(".lc-whiteboard-context-sync")?.textContent).toBe("not synced");
      expect(view.host.querySelector(".lc-dialog-foot")?.textContent).toBe("PullCancel");
      expect(view.host.querySelector('[aria-label="Hold to confirm: More"]')).toBeNull();
      for (const label of ["Save", "Export", "Restore"]) expect(view.host.querySelector(`[aria-label="Hold to confirm: ${label}"]`)).toBeTruthy();
    } finally { view.unmount(); view.host.remove(); }
  });

  it("keeps import accessible through Open when opening from outside a notebook", async () => {
    const view = mount({ defaultName: "Unrelated document" });
    try {
      expect(view.host.querySelector(".lc-whiteboard-context")).toBeNull();
      expect(view.host.querySelector('[aria-label="Hold to confirm: More"]')).toBeNull();
      await hold("Open", view.host);
      await hold("Import backup", view.host);
      expect(view.onChoose).toHaveBeenCalledWith("import");
    } finally { view.unmount(); view.host.remove(); }
  });

  it("creates a notebook only after a completed hold", async () => {
    const view = mount({ allowSave: true });
    try {
      const button = view.host.querySelector<HTMLButtonElement>('[aria-label="Hold to confirm: New"]')!;
      await act(async () => {
        button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
        button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
        button.click();
      });
      expect(view.onChoose).not.toHaveBeenCalled();
      await hold("New", view.host);
      expect(view.onChoose).toHaveBeenCalledTimes(1);
      expect(view.onChoose).toHaveBeenCalledWith("new");
    } finally { view.unmount(); view.host.remove(); }
  });

  it("retains the save draft after failure and routes Back to Whiteboard without saving", async () => {
    const view = mount({ allowSave: true, needsName: true, defaultName: "Notebook" });
    try {
      await hold("Save", view.host);
      expect(view.onChoose).not.toHaveBeenCalled();
      const input = view.host.querySelector<HTMLInputElement>(".lc-md-new-title input")!;
      act(() => fill(input, "  Sketches  "));
      view.update({ error: "Save failed. Retry." });
      expect(input.value).toBe("  Sketches  ");
      await hold("Save", view.host);
      expect(view.onChoose).toHaveBeenCalledWith("save", "Sketches");
      act(() => [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="Back")!.click());
      expect(view.host.querySelector("h2")?.textContent).toBe("Whiteboard");
      expect(view.host.querySelector("input")).toBeNull();
    } finally { view.unmount(); view.host.remove(); }
  });

  it.each([["PNG image", "export-png"], ["Whiteboard backup", "export"]])("keeps the %s export callback and nested Back path", async (label, choice) => {
    const view = mount({ allowSave: true });
    try {
      await hold("Export", view.host);
      await hold(label, view.host);
      expect(view.onChoose).toHaveBeenCalledWith(choice);
      act(() => [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="Back")!.click());
      expect(view.host.querySelector("h2")?.textContent).toBe("Whiteboard");
    } finally { view.unmount(); view.host.remove(); }
  });

  it("offers only available snapshot tiers and restores the selected tier", async () => {
    snapshots.rows = [{ kind:"whiteboard", key:"w1", tier:"2h", writtenAt:1, name:"One" }];
    const view = mount({ allowSave:true, snapshotKey:"w1" });
    try {
      await hold("Restore", view.host);
      expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Hold to confirm: Restore 24 hours snapshot"]')!.disabled).toBe(true);
      expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Hold to confirm: Restore 7 days snapshot"]')!.disabled).toBe(true);
      await hold("Restore 2 hours snapshot", view.host);
      expect(view.onChoose).toHaveBeenCalledWith("snapshot", "2h");
    } finally { view.unmount(); view.host.remove(); }
  });

  it("blocks header close, footer cancel, Escape, backdrop and Pull while pending", () => {
    const onRefreshHub = vi.fn();
    const view = mount({ pending: true, onRefreshHub });
    try {
      expect([...view.host.querySelectorAll<HTMLButtonElement>("button")].every(b=>b.disabled)).toBe(true);
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape" })));
      const backdrop=view.host.querySelector<HTMLElement>(".lc-settings-backdrop")!;
      act(()=>{backdrop.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));backdrop.click();});
      expect(view.onCancel).not.toHaveBeenCalled();
      expect(onRefreshHub).not.toHaveBeenCalled();
      view.update({ pending:false });
      act(()=>view.host.querySelector<HTMLButtonElement>(".lc-dialog-close")!.click());
      expect(view.onCancel).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); view.host.remove(); }
  });

  it("keeps leave Save and Discard choices and disables them during exit", async () => {
    const view=mount({mode:"leave",pending:false,error:null,dirty:true,defaultName:"One"});
    try {
      await hold("Save",view.host);
      await hold("Discard",view.host);
      expect(view.onChoose).toHaveBeenCalledWith("save");
      expect(view.onChoose).toHaveBeenCalledWith("discard");
      view.update({exiting:true});
      expect([...view.host.querySelectorAll<HTMLButtonElement>("button")].every(b=>b.disabled)).toBe(true);
    } finally { view.unmount();view.host.remove(); }
  });
  it("ignores the opening hold's release but allows a fresh backdrop tap", () => {
    // The toolbar press precedes mounting the dialog. Android can deliver
    // its release/click to the newly opened backdrop instead of the button.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    const view = mount();
    try {
      const backdrop = view.host.querySelector<HTMLElement>(".lc-settings-backdrop")!;
      act(() => {
        backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
        backdrop.click();
      });
      expect(view.onCancel).not.toHaveBeenCalled();
      act(() => {
        backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 }));
        backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }));
        backdrop.click();
      });
      expect(view.onCancel).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); view.host.remove(); }
  });

  it("ignores a cancelled backdrop press and a drag starting inside the menu", () => {
    const view = mount();
    try {
      const backdrop = view.host.querySelector<HTMLElement>(".lc-settings-backdrop")!;
      const panel = view.host.querySelector<HTMLElement>("[role=dialog]")!;
      act(() => {
        backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
        backdrop.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
        backdrop.click();
      });
      expect(view.onCancel).not.toHaveBeenCalled();
      act(() => {
        panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 }));
        backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }));
        backdrop.click();
      });
      expect(view.onCancel).not.toHaveBeenCalled();
    } finally { view.unmount(); view.host.remove(); }
  });

  it("moves a restored row from trash to live without remounting", async () => {
    live.rows = [];
    trash.rows = [meta({ id: "w2", title: "Trashed", deletedAt: 2 })];
    const onRestoreTrash = vi.fn(async (id: string) => {
      const row = trash.rows.find((entry) => entry.id === id);
      trash.rows = trash.rows.filter((entry) => entry.id !== id);
      if (row) {
        const { deletedAt: _deletedAt, ...rest } = row;
        live.rows = [rest];
      }
    });
    const view = mount({ onRestoreTrash });
    await hold("Load", view.host);
    await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
    expect(view.host.textContent).toContain("Restore · Trashed");
    await hold("Restore Trashed", view.host);
    await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
    expect(onRestoreTrash).toHaveBeenCalledWith("w2");
    expect(view.host.textContent).toContain("Trashed");
    expect(view.host.textContent).not.toContain("Restore · Trashed");
    view.unmount();
  });

  it("keeps matching trash below live rows without requiring the Trash filter", async () => {
    live.rows[0].title="Trashed sketch, live copy";
    const view=mount();
    try {
      await hold("Load",view.host);
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(2);
      await act(async()=>fill(view.host.querySelector('input[type="search"]')!,"trashed"));
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(2);
      const section=view.host.querySelector('section[aria-label="Trash"]')!;
      expect(section.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(1);
      await act(async()=>view.host.querySelector<HTMLButtonElement>('[aria-label="Trash"]')!.click());
      expect(view.host.querySelectorAll('.lc-scratch-load-entry')).toHaveLength(1);
      expect(view.host.textContent).not.toContain("live copy");
    } finally {view.unmount();view.host.remove();}
  });

  it("renames a load row on double-tap", async () => {
    const onRename = vi.fn(async (id: string, title: string) => {
      live.rows = live.rows.map((row) => (row.id === id ? { ...row, title } : row));
    });
    const view = mount({ onRename });
    await hold("Load", view.host);
    await tap("Load One", view.host);
    await tap("Load One", view.host);
    const input = view.host.querySelector<HTMLInputElement>(".lc-md-new-title input");
    expect(input).not.toBeNull();
    await act(async () => {
      fill(input!, "Sketchbook");
    });
    await act(async () => {
      input!.blur();
    });
    expect(onRename).toHaveBeenCalledWith("w1", "Sketchbook");
    expect(view.host.textContent).toContain("Sketchbook");
    view.unmount();
  });
});
