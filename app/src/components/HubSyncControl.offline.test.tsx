/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotatePadDto, LcClient, WhiteboardPadDto } from "../api/client";
import { savePadHub, setHostLoopback } from "../util/padHub";
import { beginPadHubStatusRequest, refreshPadHubStatus, reportPadHubStatus } from "../util/padHubStatus";
import { peekPadSyncQueueForTests, resetPadSyncQueueForTests, type PadSyncJob } from "../util/padSync";
import { HubSyncControl, type HubSyncWalkHost, type HubWalkReport } from "./HubSyncControl";

const durableQueue = vi.hoisted(() => new Map<string, PadSyncJob>());
vi.mock("../util/idb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/idb")>()),
  run: vi.fn(async (_name: string, _mode: string, action: (store: unknown) => unknown) => action({
    getAll: () => [...durableQueue.values()],
    put: (job: PadSyncJob, id: string) => durableQueue.set(id, job),
    delete: (id: string) => durableQueue.delete(id),
  })),
}));

const HUB = { url: "http://desktop.test:7878", token: "token" };
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  durableQueue.clear();
  resetPadSyncQueueForTests();
  setHostLoopback(null);
  savePadHub(HUB);
  reportPadHubStatus(beginPadHubStatusRequest(HUB), "offline");
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  savePadHub(null);
  refreshPadHubStatus();
  resetPadSyncQueueForTests();
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
    prepare: vi.fn(async () => { body.updated_at = 2; }),
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
  it.each(["annotate", "whiteboard"] as const)("persists the prepared %s pad with autosync off", async (kind) => {
    // Off is the default, so only the explicit action can queue this pad.
    localStorage.removeItem("whiteboard.hubAutoSync.v1");
    const { element, host, body, markHubAck, reports, network } = setup(kind);
    await act(async () => element.querySelector("button")!.click());
    expect(host.prepare).toHaveBeenCalledOnce();
    expect(body.updated_at).toBe(2);
    expect(peekPadSyncQueueForTests()).toEqual([
      expect.objectContaining({ op: kind === "annotate" ? "putAnnotate" : "putWhiteboard", body }),
    ]);
    expect([...durableQueue.values()]).toEqual(peekPadSyncQueueForTests());
    expect(network).not.toHaveBeenCalled();
    expect(markHubAck).not.toHaveBeenCalled();
    expect(host.onIndexDone).not.toHaveBeenCalled();
    expect(reports.some(report => report?.stage === "synced")).toBe(false);
    expect(element.querySelector("button")?.getAttribute("data-stage")).toBe("pad");
    expect(element.querySelector("button")?.getAttribute("data-error")).toContain("Desktop app is offline");
  });

  it("reports offline without making a request when no saved pad exists", async () => {
    const { element, reports, network } = setup("annotate", false);
    await act(async () => element.querySelector("button")!.click());
    expect(durableQueue.size).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect(reports.some(report => report?.stage === "synced")).toBe(false);
    expect(element.querySelector("button")?.getAttribute("data-error")).toBe("Desktop hub offline.");
  });

  it("drains a manual change when recovery happened before the change was enqueued", async () => {
    const { element, host, body, network } = setup("annotate");
    host.pad = async () => ({
      kind: "annotate", id: body.id, hubAckUpdatedAt: () => 0,
      buildBody: async () => {
        reportPadHubStatus(beginPadHubStatusRequest(HUB), "online");
        return body;
      },
      markHubAck: vi.fn(),
    });
    await act(async () => element.querySelector("button")!.click());
    // This request runs only after the status changed to online. Its failed
    // acknowledgement leaves the durable change available for another retry.
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]).toEqual([body.id, body]);
    expect(durableQueue.size).toBe(1);
    expect(element.querySelector("button")?.getAttribute("data-stage")).toBe("pad");
  });
});
