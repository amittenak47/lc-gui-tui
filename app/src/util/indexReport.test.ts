import { describe, expect, it } from "vitest";

import type { DocChunkDigest } from "../api/client";
import { compareIndexFacts, formatIndexReport, indexFacts } from "./indexReport";

function digest(over: Partial<DocChunkDigest> = {}): DocChunkDigest {
  return {
    hash: "abcdef0123456789",
    embed_model: "all-minilm",
    chunks_total: 10,
    chunks_embedded: 10,
    ...over,
  };
}

describe("indexFacts", () => {
  it("summarizes this device without per-hash rows when asked", () => {
    const facts = indexFacts([digest()], "this device", { perDocument: false });
    expect(facts.map((f) => f.label)).toEqual([
      "Index",
      "Documents",
      "Chunks",
      "Embedding model",
    ]);
    expect(facts.find((f) => f.label === "Chunks")?.value).toBe("10 (10 with vectors)");
  });

  it("lists each document on Diagnose", () => {
    const text = formatIndexReport([digest({ chunks_embedded: 4 })], "this device");
    expect(text).toContain("Index: this device");
    expect(text).toContain("abcdef01…: 10 chunks, 4 embedded · all-minilm");
  });
});

describe("compareIndexFacts", () => {
  it("names a hub disagreement", () => {
    const facts = compareIndexFacts(
      [digest()],
      [digest({ chunks_embedded: 0 })],
    );
    const vs = facts.find((f) => f.label === "This device vs hub");
    expect(vs?.value).toBe("1 document differs");
    expect(vs?.tone).toBe("warn");
  });
});
