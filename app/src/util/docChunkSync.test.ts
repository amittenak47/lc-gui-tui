import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LcApiError, type DocChunkBundle, type DocChunkDigest, type LcClient } from "../api/client";
import {
  CHUNK_MISMATCH_MESSAGE,
  clearDocChunkMismatch,
  docChunkMismatchReason,
  syncDocChunks,
} from "./docChunkSync";

const loadPadHub = vi.fn(() => null as { url: string; token: string } | null);

vi.mock("./padHub", () => ({
  loadPadHub: () => loadPadHub(),
}));

function digest(over: Partial<DocChunkDigest> = {}): DocChunkDigest {
  return {
    hash: "h",
    embed_model: "tiny-embed",
    chunks_total: 1,
    chunks_embedded: 1,
    ...over,
  };
}

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
        embedding: "AAAA",
      },
    ],
    ...over,
  };
}

function fakeClient(over: Partial<LcClient> = {}): LcClient {
  return {
    listDocChunkDigests: vi.fn(async () => [digest()]),
    listDocChunkDigestsLocal: vi.fn(async () => [digest()]),
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
    clearDocChunkMismatch("h");
  });
  afterEach(() => {
    loadPadHub.mockReset();
    clearDocChunkMismatch("h");
  });

  it("does nothing when no hub is configured", async () => {
    const client = fakeClient();
    await syncDocChunks(client, "h");
    expect(client.listDocChunkDigests).not.toHaveBeenCalled();
    expect(client.getDocChunks).not.toHaveBeenCalled();
  });

  it("skips a document whose local and remote counts already agree", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const client = fakeClient();
    await syncDocChunks(client, "h");
    expect(client.listDocChunkDigests).toHaveBeenCalled();
    expect(client.listDocChunkDigestsLocal).toHaveBeenCalled();
    expect(client.getDocChunks).not.toHaveBeenCalled();
    expect(client.putDocChunks).not.toHaveBeenCalled();
    expect(client.mergeDocChunksLocal).not.toHaveBeenCalled();
  });

  it("moves only the chunks the hub has not embedded yet", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const remote = bundle({
      chunks: [
        {
          page: 1,
          ordinal: 0,
          text_hash: "abc",
          embedded: 1,
          embedding: "AAAA",
        },
        {
          page: 2,
          ordinal: 0,
          text_hash: "def",
          embedded: 0,
          embedding: "",
        },
      ],
    });
    const local = bundle({
      chunks: [
        {
          page: 1,
          ordinal: 0,
          text_hash: "abc",
          embedded: 1,
          embedding: "AAAA",
        },
        {
          page: 2,
          ordinal: 0,
          text_hash: "def",
          embedded: 1,
          embedding: "BBBB",
        },
      ],
    });
    const client = fakeClient({
      listDocChunkDigests: vi.fn(async () => [
        digest({ chunks_total: 2, chunks_embedded: 1 }),
      ]),
      listDocChunkDigestsLocal: vi.fn(async () => [
        digest({ chunks_total: 2, chunks_embedded: 2 }),
      ]),
      getDocChunks: vi.fn(async () => remote),
      getDocChunksLocal: vi.fn(async () => local),
    });
    await syncDocChunks(client, "h");
    expect(client.putDocChunks).toHaveBeenCalledWith("h", {
      hash: "h",
      embed_model: "tiny-embed",
      chunks: [
        {
          page: 2,
          ordinal: 0,
          text_hash: "def",
          embedded: 1,
          embedding: "BBBB",
        },
      ],
    });
  });

  it("says the hub is already embedded when this device has no index", async () => {
    // §2d ships vectors and not text, so there is genuinely nothing to merge
    // onto — but a wiped device sitting next to a finished index, with nothing
    // on screen to explain it, is the worst version of that trade.
    loadPadHub.mockReturnValue({ url: "http://hub", token: "t" });
    const client = fakeClient({
      listDocChunkDigests: vi.fn(async () => [
        digest({ chunks_total: 4, chunks_embedded: 4 }),
      ]),
      listDocChunkDigestsLocal: vi.fn(async () => []),
    });
    await syncDocChunks(client, "h");
    expect(docChunkMismatchReason("h")).toContain("Index it here");
    expect(client.getDocChunks).not.toHaveBeenCalled();
  });

  it("records a mismatch instead of pushing, and leaves the reason for the chip", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const client = fakeClient({
      listDocChunkDigests: vi.fn(async () => [
        digest({ chunks_total: 1, chunks_embedded: 1 }),
      ]),
      listDocChunkDigestsLocal: vi.fn(async () => [
        digest({ chunks_total: 1, chunks_embedded: 0 }),
      ]),
      mergeDocChunksLocal: vi.fn(async () => ({
        applied: false,
        updated: 0,
        reason: "chunk text hash mismatch",
      })),
    });
    await syncDocChunks(client, "h");
    expect(client.putDocChunks).not.toHaveBeenCalled();
    expect(docChunkMismatchReason("h")).toBe(CHUNK_MISMATCH_MESSAGE);
  });

  it("does not treat a 409 as the way a mismatch arrives", async () => {
    loadPadHub.mockReturnValue({ url: "http://pc", token: "t" });
    const client = fakeClient({
      listDocChunkDigests: vi.fn(async () => [digest({ chunks_embedded: 0 })]),
      listDocChunkDigestsLocal: vi.fn(async () => [digest()]),
      mergeDocChunksLocal: vi.fn(async () => {
        throw new LcApiError("chunk text hash mismatch", 409);
      }),
    });
    await syncDocChunks(client, "h");
    expect(client.putDocChunks).not.toHaveBeenCalled();
  });
});
