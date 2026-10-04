/**
 * @vitest-environment jsdom
 */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactCatalog, PadArtifact } from "../util/padArtifacts";

const catalog = vi.hoisted(() => ({ current: undefined as ArtifactCatalog | undefined }));
const repo = vi.hoisted(() => ({
  createArtifact: vi.fn(),
  mutateArtifacts: vi.fn(),
}));
const sources = vi.hoisted(() => ({ capture: vi.fn() }));
const syncParent = vi.hoisted(() => vi.fn());
vi.mock("../util/annotateStore", () => ({ listAnnotateDocs: () => [{ id: "book", name: "Book.pdf", docType: "pdf" }], annotateDocLabel: () => "Book.pdf" }));
vi.mock("../util/artifactReferenceSources", async importOriginal => ({
  ...await importOriginal<typeof import("../util/artifactReferenceSources")>(), captureLibraryReference: sources.capture,
}));

vi.mock("../shellContext", () => ({
  useShell: () => ({ themeId: "graphite", client: {} }),
}));
vi.mock("../theme/appThemes", () => ({ isDarkTheme: () => true }));
vi.mock("../templates/whiteboard", () => ({ buildWhiteboardTemplate: () => [] }));
vi.mock("../templates/annotate", () => ({ buildAnnotateTemplate: () => [] }));
vi.mock("../canvas/convertSkeletons", () => ({ convertToExcalidrawElements: () => [] }));
vi.mock("../util/artifactSync", () => ({ syncArtifactParent: syncParent }));
vi.mock("../util/artifactRepository", () => ({
  ARTIFACTS_CHANGED: "lc-artifacts-changed",
  readArtifactCatalog: async () => catalog.current,
  artifactRef: (parent: { kind: string; id: string }, item: PadArtifact) => ({
    parent, artifactId: item.id, kind: item.content.kind,
  }),
  createArtifact: (...args: unknown[]) => repo.createArtifact(...args),
  mutateArtifacts: (...args: unknown[]) => repo.mutateArtifacts(...args),
}));

import { ArtifactPicker } from "./ArtifactPicker";
import { HOLD_FILL_MS } from "../util/gesture";
import { resetLibraryDeleteArmForTests } from "../util/armedDelete";
import { resetArtifactLocksForTests } from "../util/artifactLocks";

const parent = { kind: "whiteboard" as const, id: "nb1" };
const thread = { kind: "thread" as const, rootId: "t1" };

function note(partial: Partial<PadArtifact> & Pick<PadArtifact, "id" | "title">): PadArtifact {
  return {
    revision: "r1",
    createdAt: 1,
    updatedAt: 1,
    associations: [thread],
    content: { kind: "markdown", documentId: "d1", sourceRevision: "s1" },
    ...partial,
  };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    // @ts-expect-error jsdom may lack PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
    onchange: null,
  }));
  catalog.current = { v: 1, parent, revision: "cat1", artifacts: [] };
  repo.createArtifact.mockReset();
  repo.mutateArtifacts.mockReset();
  sources.capture.mockReset();
  syncParent.mockReset().mockResolvedValue(undefined);
  resetLibraryDeleteArmForTests();
  resetArtifactLocksForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<ComponentProps<typeof ArtifactPicker>> = {}) {
  const onAttach = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <ArtifactPicker
        parent={parent}
        associations={[thread]}
        onAttach={onAttach}
        onOpen={onOpen}
        onClose={onClose}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return { onAttach, onOpen, onClose };
}

function backdrop() {
  return document.querySelector(".lc-artifact-picker-backdrop") as HTMLElement;
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".lc-artifact-picker-backdrop button")].find((node) => node.textContent === label);
}

function attachPlus() {
  return document.querySelector<HTMLButtonElement>(".lc-artifact-picker-attach");
}

function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function choosePage(label: string, page: number) {
  const wheel = document.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`);
  expect(wheel).toBeTruthy();
  for (let current = Number(wheel!.getAttribute("aria-valuenow")); current < page; current += 1) {
    await act(async () => {
      wheel!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
  }
  expect(wheel!.getAttribute("aria-valuenow")).toBe(String(page));
}

function adornment(label: string) {
  return document.querySelector<HTMLButtonElement>(`.lc-artifact-picker-compose [aria-label="${label}"]`);
}

function pointer(node: HTMLElement, type: "pointerdown" | "pointerup" | "pointercancel") {
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0 }));
}

async function tapKind(label: string) {
  const node = adornment(label)!;
  await act(async () => {
    pointer(node, "pointerdown");
    pointer(node, "pointerup");
  });
}

async function holdKind(label: string) {
  const node = adornment(label)!;
  await act(async () => {
    pointer(node, "pointerdown");
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, HOLD_FILL_MS + 50));
  });
  await act(async () => {
    pointer(node, "pointerup");
  });
}

function control(aria: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === aria && !node.closest("[inert]"),
  );
}

async function holdControl(aria: string) {
  const node = control(aria)!;
  await act(async () => {
    pointer(node, "pointerdown");
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, HOLD_FILL_MS + 50));
  });
  await act(async () => {
    pointer(node, "pointerup");
  });
}

async function tapControl(aria: string) {
  const node = control(aria)!;
  await act(async () => {
    pointer(node, "pointerdown");
    pointer(node, "pointerup");
  });
}

function mockLifecycle() {
  repo.mutateArtifacts.mockImplementation(async (_parent, _rev, edit: { type: string; id: string }) => {
    const current = catalog.current!;
    if (edit.type === "delete") {
      catalog.current = {
        ...current,
        revision: "after-delete",
        artifacts: current.artifacts.map((item) =>
          item.id === edit.id ? { ...item, deletedAt: 9, revision: "r-del", updatedAt: 9 } : item,
        ),
      };
    }
    if (edit.type === "restore") {
      catalog.current = {
        ...current,
        revision: "after-restore",
        artifacts: current.artifacts.map((item) => {
          if (item.id !== edit.id) return item;
          const { deletedAt: _deletedAt, ...rest } = item;
          return { ...rest, revision: "r-res", restoredFrom: item.revision, updatedAt: 10 };
        }),
      };
    }
    return catalog.current;
  });
}

it("unlocks deletion and restoration while parent sync is stalled", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  mockLifecycle();
  let finish!: () => void;
  syncParent.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await mount();
  await holdControl("Delete Plan.md — hold to delete");
  await holdControl("Hold to confirm: Delete");
  try {
    expect(document.querySelector('.lc-artifact-confirm-modal:not([inert])')).toBeNull();
    expect(control("Restore Plan.md — tap to restore")?.disabled).toBe(false);
    await tapControl("Restore Plan.md — tap to restore");
    expect(repo.mutateArtifacts).toHaveBeenCalledTimes(2);
    expect(button("Open")?.disabled).toBe(false);
  } finally {
    await act(async () => { finish(); });
  }
});

it("keeps a failed local deletion open and lets the hold confirmation retry", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  repo.mutateArtifacts.mockRejectedValueOnce(new Error("Local save failed"));
  await mount();
  await holdControl("Delete Plan.md — hold to delete");
  await holdControl("Hold to confirm: Delete");
  expect(document.body.textContent).toContain("Remove this attachment?");
  expect(control("Hold to confirm: Delete")?.disabled).toBe(false);
  expect(syncParent).not.toHaveBeenCalled();
  mockLifecycle();
  await holdControl("Hold to confirm: Delete");
  expect(document.querySelector('.lc-artifact-confirm-modal:not([inert])')).toBeNull();
  expect(control("Restore Plan.md — tap to restore")).toBeTruthy();
});

it("reports a background sync failure without undoing the saved deletion or disabling restore", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  mockLifecycle();
  syncParent.mockRejectedValueOnce(new Error("Upload could not start"));
  await mount();
  await holdControl("Delete Plan.md — hold to delete");
  await holdControl("Hold to confirm: Delete");
  expect(document.querySelector('.lc-artifact-confirm-modal:not([inert])')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Upload could not start");
  expect(catalog.current!.artifacts[0].deletedAt).toBe(9);
  expect(control("Restore Plan.md — tap to restore")?.disabled).toBe(false);
  await tapControl("Restore Plan.md — tap to restore");
  expect(catalog.current!.artifacts[0].deletedAt).toBeUndefined();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("cancels partial and interrupted holds without deleting, and Escape returns to the picker", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  const { onClose } = await mount();
  await tapControl("Delete Plan.md — hold to delete");
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeNull();
  await holdControl("Delete Plan.md — hold to delete");
  expect(document.querySelector(".lc-artifact-picker-modal")?.hasAttribute("inert")).toBe(true);
  const confirm = control("Hold to confirm: Delete")!;
  await act(async () => { pointer(confirm, "pointerdown"); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  expect(Number(confirm.style.getPropertyValue("--lc-hold"))).toBeGreaterThan(0);
  await act(async () => { pointer(confirm, "pointercancel"); });
  expect(Number(confirm.style.getPropertyValue("--lc-hold"))).toBe(0);
  await act(async () => { pointer(confirm, "pointerdown"); pointer(confirm, "pointerup"); confirm.click(); });
  expect(repo.mutateArtifacts).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeNull();
  expect(document.querySelector(".lc-artifact-picker-modal")?.hasAttribute("inert")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps confirmation open during a local save and supports cancel and backdrop dismissal before saving", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  await mount();
  await holdControl("Delete Plan.md — hold to delete");
  act(() => document.querySelector<HTMLButtonElement>(".lc-artifact-confirm-modal:not([inert]) button")!.click());
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeNull();
  await holdControl("Delete Plan.md — hold to delete");
  const overlay = document.querySelector<HTMLElement>(".lc-artifact-confirm-backdrop:not([data-dialog-exiting])")!;
  act(() => { pointer(document.querySelector<HTMLElement>(".lc-artifact-confirm-modal:not([inert]) .lc-artifact-confirm-item")!, "pointerdown"); overlay.click(); });
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeTruthy();
  act(() => { pointer(overlay, "pointerdown"); pointer(overlay, "pointercancel"); overlay.click(); });
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeTruthy();
  act(() => { pointer(overlay, "pointerdown"); overlay.click(); });
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeNull();
  await holdControl("Delete Plan.md — hold to delete");
  let finish!: () => void;
  repo.mutateArtifacts.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  await holdControl("Hold to confirm: Delete");
  expect(control("Hold to confirm: Delete")?.disabled).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeTruthy();
  await act(async () => { finish(); });
  expect(document.querySelector(".lc-artifact-confirm-modal:not([inert])")).toBeNull();
});

it("attaches a selected library page with read-only provenance and selected filing", async () => {
  const capture = { title: "Book page 2", kind: "markdown", text: "excerpt", reference: { v: 1,
    parent: { kind: "annotate", id: "book" }, revision: "r", label: "Book", locator: "Page 2", capturedAt: 1, truncated: false } };
  sources.capture.mockResolvedValue(capture);
  const reference = { parent, artifactId: "captured", kind: "markdown" };
  repo.createArtifact.mockResolvedValue(reference);
  const { onAttach } = await mount({ footnoteChoices: [{ id: "mark", title: "Mark", selected: true }] });
  await act(async () => { button("Files")!.click(); });
  expect(backdrop().textContent).not.toContain("Read-only");
  await choosePage("Book.pdf page", 2);
  const plus = attachPlus();
  expect(plus?.getAttribute("aria-label")).toBe("Pin to chat");
  expect(plus?.textContent).toBe("");
  expect(document.querySelector(".lc-artifact-picker-reference-row .lc-number-wheel-fine")).toBeNull();
  await act(async () => { plus!.click(); });
  expect(sources.capture).toHaveBeenCalledWith("book", 2);
  expect(repo.createArtifact).toHaveBeenCalledWith(parent, capture.title, [{ kind: "footnote", footnoteId: "mark" }],
    expect.objectContaining({ value: expect.objectContaining({ source: "excerpt", sourceReference: capture.reference }) }));
  expect(onAttach).toHaveBeenCalledWith(reference, [{ kind: "footnote", footnoteId: "mark" }]);
});

it("captures a chosen problem-region page and keeps failures retryable", async () => {
  const capturePage = vi.fn().mockRejectedValue(new Error("The page changed. Retry."));
  const { onAttach } = await mount({ pageChoices: [{ id: "scratch", title: "Scratch", kind: "markdown", pages: 4 }], capturePage });
  await act(async () => { button("Pages & regions")!.click(); });
  await choosePage("Scratch page", 3);
  await act(async () => { attachPlus()!.click(); });
  expect(capturePage).toHaveBeenCalledWith("scratch", 3);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Retry");
  expect(onAttach).not.toHaveBeenCalled();
  expect(attachPlus()!.disabled).toBe(false);
  expect(repo.createArtifact).not.toHaveBeenCalled();
});

it("opens as a compact Settings card with enter motion, not a full-bleed sheet", async () => {
  await mount();
  const sheet = backdrop();
  expect(sheet.className).toContain("lc-settings-backdrop");
  expect(sheet.hasAttribute("data-dialog-exiting")).toBe(false);
  expect(document.querySelector(".lc-artifact-picker-modal")).toBeTruthy();
  expect(document.querySelector(".lc-settings-modal")).toBeTruthy();
  expect(sheet.textContent).not.toContain("Owned by this pad");
  expect(sheet.textContent).not.toMatch(/\bMarks\b/);
  expect(adornment("Board")).toBeTruthy();
  expect(adornment("Note")).toBeTruthy();
  expect(adornment("Code")).toBeTruthy();
  expect(adornment("Board")?.querySelector("svg")).toBeTruthy();
  expect(adornment("Board")?.textContent).toBe("");
  expect(document.querySelector('[aria-label="Create attachment"]')).toBeTruthy();
  expect(document.querySelector(".lc-artifact-picker-compose")).toBeTruthy();
  expect(document.querySelector('[aria-label="Search catalog or name a new attachment"]')).toBeTruthy();
  expect(document.querySelectorAll(".lc-artifact-picker-modal input")).toHaveLength(1);
  expect(button("Close")).toBeTruthy();
  expect(sheet.textContent).not.toContain("New whiteboard");
  expect(sheet.textContent).toContain("No saved attachments yet.");
});

it("keeps message-scoped actions without adding description text", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md", associations: [] })];
  await mount({ scope: "message" });
  expect(button("Attach")).toBeTruthy();
  expect(document.querySelector(".lc-dialog-description")).toBeNull();
  expect(document.querySelector(".lc-dialog-meta")?.textContent).toBe("Catalog");
});

it("creates from the selected kind via the end adornment", async () => {
  const { onAttach } = await mount();
  repo.createArtifact.mockResolvedValue({ parent, artifactId: "n1", kind: "code" });
  await tapKind("Code");
  expect(adornment("Code")!.getAttribute("aria-pressed")).toBe("true");
  expect(adornment("Note")!.getAttribute("aria-pressed")).toBe("false");
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Create attachment"]')!.click();
    await Promise.resolve();
  });
  expect(repo.createArtifact).toHaveBeenCalledWith(
    parent,
    "Code.py",
    [thread],
    expect.objectContaining({ kind: "code" }),
  );
  expect(onAttach).toHaveBeenCalledWith({ parent, artifactId: "n1", kind: "code" }, [thread]);
});

it("toggles create off on a second tap and keeps only one kind armed", async () => {
  await mount();
  expect(adornment("Note")!.getAttribute("aria-pressed")).toBe("true");
  await tapKind("Note");
  expect(adornment("Note")!.getAttribute("aria-pressed")).toBe("false");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Create attachment"]')!.disabled).toBe(true);
  await tapKind("Board");
  expect(adornment("Board")!.getAttribute("aria-pressed")).toBe("true");
  expect(adornment("Note")!.getAttribute("aria-pressed")).toBe("false");
  expect(adornment("Code")!.getAttribute("aria-pressed")).toBe("false");
});

it("holds a kind to underline it and filter the catalog", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [
      note({ id: "a1", title: "Plan.md" }),
      note({
        id: "a2",
        title: "helloworld.py",
        content: { kind: "code", documentId: "d2", sourceRevision: "s1" },
      }),
    ],
  };
  await mount();
  expect(backdrop().textContent).toContain("Plan.md");
  expect(backdrop().textContent).toContain("helloworld.py");
  await holdKind("Code");
  expect(adornment("Code")!.className).toContain("is-filter");
  expect(adornment("Note")!.className).not.toContain("is-filter");
  expect(backdrop().textContent).toContain("helloworld.py");
  expect(backdrop().textContent).not.toContain("Plan.md");
  await holdKind("Code");
  expect(adornment("Code")!.className).not.toContain("is-filter");
  expect(backdrop().textContent).toContain("Plan.md");
});

it("opens the footnotes submenu from the start adornment", async () => {
  const onToggleFootnote = vi.fn();
  await mount({
    footnoteChoices: [{ id: "f1", title: "Lemma", number: 2, selected: false }],
    onToggleFootnote,
  });
  expect(document.querySelector('[aria-label="Footnotes"]')).toBeTruthy();
  expect(document.querySelector('[aria-label="Footnotes"] svg')).toBeTruthy();
  expect(document.querySelector('[aria-label="Footnotes"]')?.textContent).not.toMatch(/Footnotes/);
  expect(backdrop().textContent).not.toMatch(/\bMarks\b/);
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Footnotes"]')!.click());
  const menu = document.querySelector('[aria-label="Page footnotes"]');
  expect(menu).toBeTruthy();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="2. Lemma"]')!.click());
  expect(onToggleFootnote).toHaveBeenCalledWith("f1");
});

it("filters the catalog and names a create from the same field", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [note({ id: "a1", title: "Plan.md" }), note({ id: "a2", title: "Other.md" })],
  };
  const { onAttach } = await mount();
  const field = document.querySelector<HTMLInputElement>('[aria-label="Search catalog or name a new attachment"]')!;
  act(() => fill(field, "plan"));
  expect(backdrop().textContent).toContain("Plan.md");
  expect(backdrop().textContent).not.toContain("Other.md");
  act(() => fill(field, "Sketch"));
  repo.createArtifact.mockResolvedValue({ parent, artifactId: "n2", kind: "markdown" });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Create attachment"]')!.click();
    await Promise.resolve();
  });
  expect(repo.createArtifact).toHaveBeenCalledWith(
    parent,
    "Sketch",
    [thread],
    expect.objectContaining({ kind: "markdown" }),
  );
  expect(onAttach).toHaveBeenCalledWith({ parent, artifactId: "n2", kind: "markdown" }, [thread]);
});

it("lists catalog rows without preview cards", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [note({ id: "a1", title: "Plan.md" })],
  };
  await mount();
  expect(document.querySelector(".lc-artifact-card")).toBeNull();
  expect(document.querySelector(".lc-artifact-picker-kind svg")).toBeTruthy();
  expect(document.querySelector(".lc-artifact-picker-kind")?.getAttribute("aria-label")).toBe("Note");
  expect(backdrop().textContent).toContain("Plan.md");
  expect(backdrop().textContent).not.toContain("On this thread");
  expect(button("Pin to chat")).toBeUndefined();
  expect(button("Attached")?.disabled).toBe(true);
  expect(button("Unfile")).toBeTruthy();
  expect(button("Open")).toBeTruthy();
});

it("pins a catalog item onto chat and starts the leave animation", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [note({ id: "a2", title: "Other.md", associations: [{ kind: "file" }] })],
  };
  const { onAttach, onClose } = await mount();
  repo.mutateArtifacts.mockResolvedValue(catalog.current);
  await act(async () => {
    button("Pin to chat")!.click();
    await Promise.resolve();
  });
  expect(repo.mutateArtifacts).toHaveBeenCalled();
  expect(onAttach).toHaveBeenCalledWith({ parent, artifactId: "a2", kind: "markdown" }, [thread]);
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it("plays the Settings leave animation before unmounting", async () => {
  const { onClose } = await mount();
  vi.useFakeTimers();
  act(() => button("Close")!.click());
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(180); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("skips the leave animation when motion is reduced", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
    onchange: null,
  }));
  const { onClose } = await mount();
  act(() => button("Close")!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("trashes through hold + in-app confirm, then restores from the same row", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [note({ id: "a1", title: "Plan.md" })],
  };
  mockLifecycle();
  const confirm = vi.spyOn(window, "confirm");
  await mount();
  expect(control("Delete Plan.md — hold to delete")).toBeTruthy();
  await holdControl("Delete Plan.md — hold to delete");
  expect(confirm).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Remove this attachment?");
  expect(repo.mutateArtifacts).not.toHaveBeenCalled();
  await holdControl("Hold to confirm: Delete");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(repo.mutateArtifacts).toHaveBeenCalledWith(
    parent,
    "cat1",
    expect.objectContaining({ type: "delete", id: "a1" }),
  );
  expect(document.querySelector('.lc-artifact-confirm-modal:not([inert])')).toBeNull();
  expect(backdrop().textContent).toContain("TRASH");
  expect(button("Open")).toBeUndefined();
  expect(control("Restore Plan.md — tap to restore")).toBeTruthy();
  await tapControl("Restore Plan.md — tap to restore");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(repo.mutateArtifacts).toHaveBeenCalledWith(
    parent,
    "after-delete",
    expect.objectContaining({ type: "restore", id: "a1" }),
  );
  expect(button("Open")).toBeTruthy();
  expect(control("Delete Plan.md — tap to delete")).toBeTruthy();
  confirm.mockRestore();
});

it("hides trash while the compact padlock is on", async () => {
  catalog.current = {
    v: 1, parent, revision: "cat1",
    artifacts: [note({ id: "a1", title: "Plan.md" })],
  };
  await mount();
  expect(control("Delete Plan.md — hold to delete")).toBeTruthy();
  act(() => control("Lock Plan.md")!.click());
  expect(control("Unlock Plan.md")).toBeTruthy();
  expect(control("Delete Plan.md — hold to delete")).toBeUndefined();
});

it("uses only the reference footer close with the existing exit lifecycle", async () => {
  const { onClose, onOpen } = await mount();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-labelledby")).toBe("lc-artifact-picker-title");
  vi.useFakeTimers();
  expect(control("Close Attachments")).toBeUndefined();
  act(() => button("Close")!.click());
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(180); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  expect(repo.mutateArtifacts).not.toHaveBeenCalled();
});

it("keeps source, query and selected page when the presentation variant changes", async () => {
  const pageChoices = [{ id: "scratch", title: "Scratch", kind: "markdown" as const, pages: 4 }];
  await mount({ pageChoices });
  await act(async () => { button("Pages & regions")!.click(); });
  await choosePage("Scratch page", 3);
  const field = document.querySelector<HTMLInputElement>('[aria-label="Search catalog or name a new attachment"]')!;
  act(() => fill(field, "Scratch"));
  await mount({ pageChoices, shape: "blocky" });
  expect(document.querySelector('[role="dialog"]')?.getAttribute("data-dialog-shape")).toBe("blocky");
  expect(document.querySelector('[aria-label="Search catalog or name a new attachment"]')).toBe(field);
  expect(field.value).toBe("Scratch");
  expect(button("Pages & regions")!.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("3");
  expect(repo.createArtifact).not.toHaveBeenCalled();
  expect(repo.mutateArtifacts).not.toHaveBeenCalled();
});

it("does not dismiss when a gesture starts inside the new header and ends on the backdrop", async () => {
  const { onClose } = await mount();
  act(() => {
    pointer(document.querySelector<HTMLElement>(".lc-dialog-head")!, "pointerdown");
    backdrop().click();
  });
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  act(() => {
    pointer(backdrop(), "pointerdown");
    backdrop().click();
  });
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(true);
});

it("unfiles only the selected associations and retains catalog revision checks", async () => {
  const other = { kind: "footnote" as const, footnoteId: "other" };
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md", associations: [thread, other] })];
  const { onClose, onAttach } = await mount();
  repo.mutateArtifacts.mockResolvedValue(catalog.current);
  await act(async () => { button("Unfile")!.click(); });
  expect(repo.mutateArtifacts).toHaveBeenCalledWith(parent, "cat1", {
    type: "update", id: "a1", expectedRevision: "r1", patch: { associations: [other] },
  });
  expect(onAttach).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("blocks dismissal while saving locally and keeps a failed attachment retryable", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md", associations: [] })];
  let rejectAttach!: (reason: Error) => void;
  repo.mutateArtifacts.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAttach = reject; }));
  const { onAttach, onClose } = await mount();
  await act(async () => { button("Pin to chat")!.click(); });
  expect(button("Close")!.disabled).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  act(() => { pointer(backdrop(), "pointerdown"); backdrop().click(); });
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(false);
  expect(button("Files")!.disabled).toBe(true);
  expect(document.querySelector(".lc-dialog-hint")).toBeNull();
  await act(async () => { rejectAttach(new Error("Catalog changed. Retry.")); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Retry");
  expect(button("Close")!.disabled).toBe(false);
  expect(button("Pin to chat")!.disabled).toBe(false);
  expect(onAttach).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  repo.mutateArtifacts.mockResolvedValue(catalog.current);
  await act(async () => { button("Pin to chat")!.click(); });
  expect(repo.mutateArtifacts).toHaveBeenCalledTimes(2);
  expect(onAttach).toHaveBeenCalledTimes(1);
  expect(backdrop().hasAttribute("data-dialog-exiting")).toBe(true);
});

it("opens a catalog entry after exit without modifying it", async () => {
  catalog.current!.artifacts = [note({ id: "a1", title: "Plan.md" })];
  const { onOpen, onClose } = await mount();
  vi.useFakeTimers();
  act(() => button("Open")!.click());
  expect(onOpen).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(180); });
  expect(onOpen).toHaveBeenCalledWith({ parent, artifactId: "a1", kind: "markdown" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(repo.mutateArtifacts).not.toHaveBeenCalled();
});

it.each([
  ["Board", "whiteboard", "Whiteboard"],
  ["Note", "markdown", "Note.md"],
  ["Code", "code", "Code.py"],
])("creates a %s attachment with the correct snapshot kind", async (label, kind, title) => {
  const { onAttach } = await mount();
  if (label !== "Note") await tapKind(label);
  const ref = { parent, artifactId: "created", kind };
  repo.createArtifact.mockResolvedValue(ref);
  await act(async () => { control("Create attachment")!.click(); });
  expect(repo.createArtifact).toHaveBeenCalledWith(parent, title, [thread], expect.objectContaining({ kind }));
  expect(onAttach).toHaveBeenCalledWith(ref, [thread]);
});
