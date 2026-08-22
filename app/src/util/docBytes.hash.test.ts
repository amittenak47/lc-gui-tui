/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

describe("lengthFromHash", () => {
  it("reads back the length hashBytes encoded", async () => {
    const { hashBytes, lengthFromHash } = await import("./docBytes");
    const bytes = new Uint8Array(859).buffer;
    expect(lengthFromHash(hashBytes(bytes))).toBe(859);
  });

  it("leaves a key this build did not write alone", async () => {
    const { lengthFromHash } = await import("./docBytes");
    expect(lengthFromHash("sha256:abc")).toBeNull();
    expect(lengthFromHash("binabc")).toBeNull();
  });
});
