/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HOLD_MS } from "../util/gesture";
import type { AnnotateDocMeta } from "../util/annotateStore";

const live = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));
const trash = vi.hoisted(() => ({ rows: [] as AnnotateDocMeta[] }));

vi.mock("../util/annotateStore", () => ({
  listAnnotateDocs: () => live.rows,
  listAnnotateTrash: () => trash.rows,
  deleteAnnotateDoc: vi.fn(),
  setAnnotateDocLocked: vi.fn(),
  annotateDocLabel: (doc: AnnotateDocMeta) => doc.label?.trim() || doc.name,
}));

vi.mock("../util/padSnapshotStore", () => ({
  listPadSnapshots: async () => [],
  PAD_SNAPSHOT_TIERS: [],
}));

vi.mock("../util/padSync", () => ({
  TOMBSTONE_COPY: "Trash on this device — three days, then gone.",
}));

import { AnnotateDialog } from "./AnnotateDialog";

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
    { id: "d1", name: "note.md", hash: "h1", docType: "markdown", updatedAt: 1 },
    { id: "w1", name: "https://example.com/", hash: "h2", docType: "web", updatedAt: 2, label: "Example" },
  ];
  trash.rows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function mount(props: {
  kind?: "document" | "web";
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
      <AnnotateDialog mode="entry" onChoose={onChoose} onCancel={onCancel} {...props} />,
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

describe("AnnotateDialog", () => {
  it("keeps web pads out of the document Recent list", async () => {
    const view = mount({ kind: "document" });
    await hold("Recent", view.host);
    expect(view.host.textContent).toContain("note.md");
    expect(view.host.textContent).not.toContain("Example");
    expect(view.host.textContent).not.toContain("https://example.com/");
    view.unmount();
  });

  it("lists only web pads in the Pages Recent list", async () => {
    const view = mount({ kind: "web" });
    await hold("Recent", view.host);
    expect(view.host.textContent).toContain("Example");
    expect(view.host.textContent).not.toContain("note.md");
    view.unmount();
  });

  it("moves a restored row from trash to live without remounting", async () => {
    live.rows = [];
    trash.rows = [
      { id: "d1", name: "note.md", hash: "h1", docType: "markdown", updatedAt: 1, deletedAt: 2 },
    ];
    const onRestoreTrash = vi.fn(async (id: string) => {
      const row = trash.rows.find((entry) => entry.id === id);
      trash.rows = trash.rows.filter((entry) => entry.id !== id);
      if (row) {
        const { deletedAt: _deletedAt, ...rest } = row;
        live.rows = [rest];
      }
    });
    const view = mount({ kind: "document", onRestoreTrash });
    await hold("Recent", view.host);
    expect(view.host.textContent).toContain("Restore · note.md");
    await hold("Restore note.md", view.host);
    expect(onRestoreTrash).toHaveBeenCalledWith("d1");
    expect(view.host.textContent).toContain("note.md");
    expect(view.host.textContent).not.toContain("Restore · note.md");
    view.unmount();
  });

  it("renames a recent row on double-tap", async () => {
    const onRename = vi.fn(async (id: string, title: string) => {
      live.rows = live.rows.map((row) => (row.id === id ? { ...row, label: title } : row));
    });
    const view = mount({ kind: "document", onRename });
    await hold("Recent", view.host);
    await tap("Open note.md", view.host);
    await tap("Open note.md", view.host);
    const input = view.host.querySelector<HTMLInputElement>(".lc-md-new-title input");
    expect(input).not.toBeNull();
    await act(async () => {
      fill(input!, "Lecture notes");
    });
    await act(async () => {
      input!.blur();
    });
    expect(onRename).toHaveBeenCalledWith("d1", "Lecture notes");
    expect(view.host.textContent).toContain("Lecture notes");
    view.unmount();
  });
});
