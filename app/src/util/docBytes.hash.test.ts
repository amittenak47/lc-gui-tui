/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

describe("lengthFromHash", () => {
  it("reads back the length hashBytes encoded", async () => {
    const { hashBytes, hashBytesAsync, hashBytesCooperative, lengthFromHash } = await import("./docBytes");
    const bytes = new Uint8Array(859).buffer;
    expect(lengthFromHash(hashBytes(bytes))).toBe(859);
    expect(await hashBytesCooperative(bytes)).toBe(hashBytes(bytes));
    expect(await hashBytesAsync(bytes)).toBe(hashBytes(bytes));
  });

  it("does not hash a body while the camera is moving", async () => {
    const { hashBytesCooperative } = await import("./docBytes");
    const { noteCameraBusy, resetCameraBusyForTests } = await import("./cameraBusy");
    noteCameraBusy();
    const bytes = new Uint8Array(128 * 1024 + 4).buffer;
    expect(await hashBytesCooperative(bytes)).toBe("");
    resetCameraBusyForTests();
  });

  it("leaves a key this build did not write alone", async () => {
    const { lengthFromHash } = await import("./docBytes");
    expect(lengthFromHash("sha256:abc")).toBeNull();
    expect(lengthFromHash("binabc")).toBeNull();
  });
});
