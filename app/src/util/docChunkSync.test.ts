import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LcApiError, type LcClient, type DocChunkBundle } from "../api/client";
import { syncDocChunks } from "./docChunkSync";

const loadPadHub = vi.fn(() => null as { url: string; token: string } | null);

vi.mock("./padHub", () => ({
  loadPadHub: () => loadPadHub(),
}));

function bundle(over: Partial<DocChunkBundle> = {}): DocChunkBundle {
  return {
    hash: "h",
    embed_model: "tiny-embed",
    chunks: [
      {
        page: 1,
        ordinal: 0,
        text_hash: "abc",
        embedded: 1,
        embedding: "00",
      },
    ],
    ...over,
  };
}

function fakeClient(over: Partial<LcClient> = {}): LcClient {
  return {
    getDocChunks: vi.fn(async () => bundle()),
    getDocChunksLocal: vi.fn(async () => bundle()),
    putDocChunks: vi.fn(async () => ({ applied: true, updated: 1 })),
    mergeDocChunksLocal: vi.fn(async () => ({ applied: true, updated: 1 })),
    ...over,
  } as LcClient;
}

describe("syncDocChunks", () => {
  beforeEach(() => {
    loadPadHub.mockReturnValue(null);
  });
  afterEach(() => {
    loadPadHub.mockReset();
  });

  it("does nothing when no hub is configured", async () => {
    const client = fakeClient();
    await syncDocChunks(client, "h");
    expect(client.getDocChunks).not.toHaveBeenCalled();
  });

  it("merges remote into local then pushes local to the hub", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const client = fakeClient();
    await syncDocChunks(client, "h");
    expect(client.getDocChunks).toHaveBeenCalledWith("h");
    expect(client.mergeDocChunksLocal).toHaveBeenCalled();
    expect(client.putDocChunks).toHaveBeenCalled();
  });

  it("skips the push when a text-hash mismatch refuses the merge", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const client = fakeClient({
      mergeDocChunksLocal: vi.fn(async () => {
        throw new LcApiError("chunk text hash mismatch; local index dropped", 409);
      }),
    });
    await syncDocChunks(client, "h");
    expect(client.putDocChunks).not.toHaveBeenCalled();
  });
});
