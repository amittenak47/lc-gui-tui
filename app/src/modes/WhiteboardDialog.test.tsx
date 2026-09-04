/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HOLD_MS } from "../util/gesture";
import type { WhiteboardNotebookMeta } from "../util/whiteboardStore";

const live = vi.hoisted(() => ({ rows: [] as WhiteboardNotebookMeta[] }));
const trash = vi.hoisted(() => ({ rows: [] as WhiteboardNotebookMeta[] }));

vi.mock("../util/whiteboardStore", () => ({
  listWhiteboardNotebooks: () => live.rows,
  listWhiteboardTrash: () => trash.rows,
  deleteWhiteboardNotebook: vi.fn(),
  setWhiteboardNotebookLocked: vi.fn(),
}));

vi.mock("../util/padSnapshotStore", () => ({
  listPadSnapshots: async () => [],
  PAD_SNAPSHOT_TIERS: [],
}));

vi.mock("../util/padSync", () => ({
  TOMBSTONE_COPY: "Trash on this device — three days, then gone.",
}));

import { WhiteboardDialog } from "./WhiteboardDialog";

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
});

afterEach(() => {
  vi.useRealTimers();
});

function meta(partial: Partial<WhiteboardNotebookMeta> & { id: string; title: string }): WhiteboardNotebookMeta {
  return { updatedAt: 1, pageCount: 1, ...partial };
}

function mount(props: {
  onRestoreTrash?: (id: string) => void | Promise<void>;
  onRename?: (id: string, title: string) => void | Promise<void>;
} = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <WhiteboardDialog
        mode="entry"
        onChoose={onChoose}
        onCancel={onCancel}
        {...props}
      />,
    );
  });
  return {
    host,
    onChoose,
    unmount: () => act(() => root.unmount()),
  };
}

function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function hold(label: string, host: HTMLElement) {
  const aria = `Hold to confirm: ${label}`;
  const button = Array.from(host.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === aria,
  );
  expect(button, `missing hold button "${aria}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 50));
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
    expect(view.host.textContent).toContain("Restore · Trashed");
    await hold("Restore Trashed", view.host);
    expect(onRestoreTrash).toHaveBeenCalledWith("w2");
    expect(view.host.textContent).toContain("Trashed");
    expect(view.host.textContent).not.toContain("Restore · Trashed");
    view.unmount();
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
