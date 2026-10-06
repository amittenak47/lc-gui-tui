/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotatePadDto, LcClient, WhiteboardPadDto } from "../api/client";
import { savePadHub, setHostLoopback } from "../util/padHub";
import { beginPadHubStatusRequest, refreshPadHubStatus, reportPadHubStatus } from "../util/padHubStatus";
import { memoryBookTransaction } from "../util/testBookTransaction";
import { mutateLocalBook, resetLocalBookStoreForTests } from "../util/localBookStore";
import { resetBookCoordinatorForTests } from "../util/bookCoordinator";
import { HubSyncControl, type HubSyncWalkHost, type HubWalkReport } from "./HubSyncControl";

const durable = vi.hoisted(() => new Map<string, Map<IDBValidKey, unknown>>());
vi.mock("../util/idb", async original => ({
  ...await original<typeof import("../util/idb")>(),
  withTransaction: async (_names: string[], _mode: string, work: Parameters<typeof memoryBookTransaction>[1]) => memoryBookTransaction(durable, work),
}));

const HUB = { url: "http://desktop.test:7878", token: "token" };
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  durable.clear(); localStorage.clear();
  resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  setHostLoopback(null);
  savePadHub(HUB);
  reportPadHubStatus(beginPadHubStatusRequest(HUB), "offline");
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  savePadHub(null);
  refreshPadHubStatus();
  resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  vi.unstubAllGlobals();
});

function setup(kind: "annotate" | "whiteboard", hasPad = true) {
  const body: AnnotatePadDto | WhiteboardPadDto = kind === "annotate"
    ? { id: "pad", name: "Note", hash: "hash", doc_type: "markdown", updated_at: 1,
      source: "text", board: {}, footnotes: [], agent: [] }
    : { id: "pad", title: "Board", updated_at: 1, page_count: 1, board: {}, agent: [] };
  const markHubAck = vi.fn();
  const reports: Array<HubWalkReport | null> = [];
  const host: HubSyncWalkHost = {
    prepare: vi.fn(async () => {
      body.updated_at = 2;
      if (hasPad) await mutateLocalBook({ kind, id: "pad" }, {}, ctx => {
        ctx.setContent(body); ctx.setMetadata({ kind, id: "pad", name: "Saved" });
      });
    }),
    doc: () => kind === "annotate"
      ? { hash: "hash", name: "Note", docType: "markdown", text: "text", bytes: null }
      : null,
    pad: async () => hasPad ? {
      kind, id: "pad", hubAckUpdatedAt: () => 0,
      buildBody: () => body, markHubAck,
    } : null,
    emitReload: vi.fn(), inkSince: () => 0,
    onConflict: vi.fn(async () => ({ pick: "local" as const })),
    onIndexProgress: vi.fn(), onWalkProgress: report => reports.push(report),
    onIndexError: vi.fn(), onIndexDone: vi.fn(),
  };
  const network = vi.fn().mockRejectedValue(new Error("The offline walk must not use the hub"));
  const client = new Proxy({}, { get: () => network }) as LcClient;
  const element = document.createElement("div");
  const root = createRoot(element);
  roots.push(root);
  act(() => root.render(<HubSyncControl client={client} host={host} />));
  return { element, host, body, markHubAck, reports, network };
}

describe("manual Sync while the desktop is offline", () => {
  it.each(["annotate", "whiteboard"] as const)("retains the prepared %s current state with autosync off", async (kind) => {
    // Preparation saves locally even while automatic synchronization is off.
    localStorage.removeItem("whiteboard.hubAutoSync.v1");
    const { element, host, body, markHubAck, reports, network } = setup(kind);
    await act(async () => element.querySelector("button")!.click());
    expect(host.prepare).toHaveBeenCalledOnce();
    expect(body.updated_at).toBe(2);
    expect(durable.get("content")!.get("pad")).toEqual(body);
    expect(durable.get("sync_state")!.get(`${kind}:pad`)).toMatchObject({ bootstrap: true, syncedChangeSeq: 0 });
    expect(durable.get("book_meta")!.get(`${kind}:pad`)).toMatchObject({ id: "pad", name: "Saved" });
    expect(network).not.toHaveBeenCalled();
    expect(markHubAck).not.toHaveBeenCalled();
    expect(host.onIndexDone).not.toHaveBeenCalled();
    expect(reports.some(report => report?.stage === "synced")).toBe(false);
    expect(element.querySelector("button")?.getAttribute("data-stage")).toBe("failed");
    expect(element.querySelector("button")?.getAttribute("data-error")).toContain("Can't reach the hub");
  });

  it("reports offline without making a request when no saved pad exists", async () => {
    const { element, reports, network } = setup("annotate", false);
    await act(async () => element.querySelector("button")!.click());
    expect(durable.size).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect(reports.some(report => report?.stage === "synced")).toBe(false);
    expect(element.querySelector("button")?.getAttribute("data-error")).toContain("Can't reach the hub");
  });

  it("retains a newer edit after failure and does not mutate on reachability recovery", async () => {
    const { element, body, network } = setup("annotate");
    await act(async () => element.querySelector("button")!.click());
    await mutateLocalBook({ kind: "annotate", id: "pad" }, {}, ctx => ctx.setContent({ ...body, source: "newer edit" }));
    expect(durable.get("content")!.get("pad")).toMatchObject({ source: "newer edit" });
    expect(durable.get("sync_state")!.get("annotate:pad")).toMatchObject({ syncedChangeSeq: 0 });
    reportPadHubStatus(beginPadHubStatusRequest(HUB), "online");
    await Promise.resolve();
    expect(network).not.toHaveBeenCalled();
    expect(durable.get("content")!.get("pad")).toMatchObject({ source: "newer edit" });
    expect(element.querySelector("button")?.getAttribute("data-stage")).toBe("failed");
  });
});
