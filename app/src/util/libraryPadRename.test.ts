/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushWhiteboardPad, pushAnnotatePad } = vi.hoisted(() => ({
  pushWhiteboardPad: vi.fn(async (_client?: unknown, _notebook?: unknown) => true),
  pushAnnotatePad: vi.fn(async (_client?: unknown, _doc?: unknown) => true),
}));

vi.mock("./padSync", () => ({
  pushWhiteboardPad: (client: unknown, notebook: unknown) => pushWhiteboardPad(client, notebook),
  pushAnnotatePad: (client: unknown, doc: unknown) => pushAnnotatePad(client, doc),
}));

import type { LcClient } from "../api/client";
import type { BoardBlob } from "../canvas/BoardHandle";
import { saveAnnotateDoc, listAnnotateDocs } from "./annotateStore";
import { renameLibraryPad } from "./libraryPadRename";
import { listWhiteboardNotebooks, saveWhiteboardNotebook } from "./whiteboardStore";

function board(mark = "a"): BoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
    ink: [],
  } as BoardBlob;
}

const client = {} as LcClient;

beforeEach(() => {
  pushWhiteboardPad.mockClear();
  pushAnnotatePad.mockClear();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renameLibraryPad", () => {
  it("pushes the whiteboard with the new title", async () => {
    const saved = await saveWhiteboardNotebook({ board: board(), pageCount: 1, title: "One" });
    await renameLibraryPad(client, "whiteboard", saved.id, "Sketchbook");
    expect(listWhiteboardNotebooks()[0]!.title).toBe("Sketchbook");
    expect(pushWhiteboardPad).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: saved.id, title: "Sketchbook" }),
    );
  });

  it("pushes the annotate pad with the new label, leaving the URL name alone", async () => {
    const saved = await saveAnnotateDoc({
      name: "https://example.com/page",
      hash: "h",
      docType: "web",
      source: "",
      board: board(),
    });
    await renameLibraryPad(client, "annotate", saved.id, "Reading list");
    expect(listAnnotateDocs()[0]!.label).toBe("Reading list");
    expect(listAnnotateDocs()[0]!.name).toBe("https://example.com/page");
    expect(pushAnnotatePad).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        id: saved.id,
        label: "Reading list",
        name: "https://example.com/page",
      }),
    );
  });
});
