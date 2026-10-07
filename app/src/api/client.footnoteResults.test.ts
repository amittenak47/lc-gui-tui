import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  hub: null as null | { url: string; token: string },
  invoke: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./nativeHttp", async (original) => ({
  ...(await original<typeof import("./nativeHttp")>()),
  loadInvoke: async () => transport.invoke,
}));
vi.mock("../util/padHub", async (original) => ({
  ...(await original<typeof import("../util/padHub")>()),
  loadPadHub: () => transport.hub,
}));
vi.mock("../util/padHubStatus", async (original) => ({
  ...(await original<typeof import("../util/padHubStatus")>()),
  isPadHubOffline: () => false,
  beginPadHubStatusRequest: vi.fn(),
  reportPadHubStatus: vi.fn(),
}));

import { LcClient } from "./client";

const DEVICE_ID = "device-a";
const rows = [{ id: "fr-a", doc_id: "doc-1", result: { notes: ["from results"] } }];

function installStorage(): void {
  const values = new Map<string, string>([["whiteboard.deviceId.v1", DEVICE_ID]]);
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    key() {
      return null;
    },
  });
}

function respond(body: unknown, status = 200): void {
  transport.invoke.mockResolvedValue({ status, body });
  transport.fetch.mockImplementation(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  transport.invoke.mockReset();
  transport.fetch.mockReset();
  transport.hub = null;
  installStorage();
  vi.stubGlobal("fetch", transport.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("footnote results", () => {
  it("asks the desktop command for this device's results", async () => {
    respond({ footnote_results: rows });
    const found = await new LcClient().footnoteResults();
    expect(found).toEqual(rows);
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(transport.invoke).toHaveBeenCalledWith("lc_footnote_results", { device: DEVICE_ID });
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("asks the hub endpoint for this device's results", async () => {
    transport.hub = { url: "http://hub.test", token: "123456" };
    respond({ footnote_results: rows });
    const found = await new LcClient().footnoteResults();
    expect(found).toEqual(rows);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://hub.test/footnote-results?device=${encodeURIComponent(DEVICE_ID)}`);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "x-lc-token": "123456" });
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("treats a missing results list as empty", async () => {
    respond({});
    expect(await new LcClient().footnoteResults()).toEqual([]);
    respond({ footnote_results: "nope" });
    expect(await new LcClient().footnoteResults()).toEqual([]);
  });
});
