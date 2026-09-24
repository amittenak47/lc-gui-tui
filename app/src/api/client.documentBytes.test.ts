import { afterEach, describe, expect, it, vi } from "vitest";
import { LcClient } from "./client";
import { HUB_MAX_DOCUMENT_BYTES } from "../util/padHub";

vi.mock("../util/padHub", async original => ({
  ...await original<typeof import("../util/padHub")>(),
  loadPadHub: () => ({url:"http://hub.test",token:"test"}),
}));
afterEach(() => vi.unstubAllGlobals());

describe("document byte uploads", () => {
  it("sends a textbook larger than the JSON request limit as binary", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null,{status:204}));
    vi.stubGlobal("fetch",fetch);
    const bytes = new ArrayBuffer(44_858_555);
    await new LcClient().putDocBytes("textbook",bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://hub.test/docs/textbook/bytes");
    expect(fetch.mock.calls[0]?.[1].method).toBe("PUT");
    expect(fetch.mock.calls[0]?.[1].body).toBe(bytes);
  });
  it("explains rejection by an older desktop server", async () => {
    vi.stubGlobal("fetch",vi.fn(async () => new Response("Failed to buffer the request body",{status:413})));
    await expect(new LcClient().putDocBytes("book",new ArrayBuffer(1))).rejects.toThrow("Update and restart the desktop app");
  });
  it("rejects files above the document limit before sending", async () => {
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(new LcClient().putDocBytes("book",{byteLength:HUB_MAX_DOCUMENT_BYTES+1} as ArrayBuffer)).rejects.toThrow("512 MiB");
    expect(fetch).not.toHaveBeenCalled();
  });
});
