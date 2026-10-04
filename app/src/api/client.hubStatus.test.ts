/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LcClient, PadHubOfflineError, probePadHubHealth } from "./client";
import { savePadHub, setHostLoopback } from "../util/padHub";
import {
  beginPadHubStatusRequest, getPadHubStatus, refreshPadHubStatus, reportPadHubStatus,
} from "../util/padHubStatus";

const HUB = { url: "http://hub.test", token: "123456" };
const client = new LcClient();

beforeEach(() => {
  setHostLoopback(null);
  savePadHub(null);
  refreshPadHubStatus();
  savePadHub(HUB);
  refreshPadHubStatus();
});
afterEach(() => {
  savePadHub(null);
  refreshPadHubStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("real hub requests", () => {
  it("fails reads and writes immediately when the configured hub is offline", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    reportPadHubStatus(beginPadHubStatusRequest(HUB), "offline");
    await expect(client.getProblemPad("leetcode", "1")).rejects.toBeInstanceOf(PadHubOfflineError);
    await expect(client.tombstoneProblemPad("leetcode", "1")).rejects.toThrow("Desktop hub offline");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks an acknowledged request online", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })));
    await client.getProblemPad("leetcode", "1");
    expect(getPadHubStatus().status).toBe("online");
  });

  it("keeps HTTP application errors online and actionable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad code", { status: 401 })));
    await expect(client.getProblemPad("leetcode", "1")).rejects.toMatchObject({ status: 401 });
    expect(getPadHubStatus().status).toBe("online");
  });

  it("marks network failures offline without posting the server banner event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const banner = vi.fn();
    window.addEventListener("lc-server-unreachable", banner);
    try {
      await expect(client.tombstoneProblemPad("leetcode", "1")).rejects.toMatchObject({ status: 0 });
      expect(getPadHubStatus().status).toBe("offline");
      expect(banner).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("lc-server-unreachable", banner);
    }
  });

  it("bounds a body that hangs after response headers and then fails later calls fast", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    }) as Response);
    vi.stubGlobal("fetch", fetch);
    const pending = expect(client.getProblemPad("leetcode", "1")).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(getPadHubStatus().status).toBe("offline");
    await expect(client.getProblemPad("leetcode", "1")).rejects.toBeInstanceOf(PadHubOfflineError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cannot let a previous hub's late request change the new hub status", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { complete = done; })));
    const pending = client.getProblemPad("leetcode", "1");
    savePadHub({ ...HUB, token: "654321" });
    complete(new Response("{}", { headers: { "content-type": "application/json" } }));
    await pending;
    expect(getPadHubStatus()).toEqual({ hub: { ...HUB, token: "654321" }, status: "unknown" });
  });
});

describe("cheap health probe", () => {
  it("uses only health and treats an HTTP answer as reachable", async () => {
    const fetch = vi.fn(async (_url: string) => new Response("Temporary failure", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(probePadHubHealth(HUB)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://hub.test/health");
  });

  it("stops after three seconds even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const pending = probePadHubHealth(HUB);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
