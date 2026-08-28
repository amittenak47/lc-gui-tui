/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForFontsReady } from "./fontsReady";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("waitForFontsReady", () => {
  it("resolves when fonts.ready never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      fonts: { ready: new Promise<void>(() => {}) },
    });
    const done = waitForFontsReady(40);
    const raced = Promise.race([
      done.then(() => "ok"),
      new Promise<string>((resolve) => {
        window.setTimeout(() => resolve("hung"), 200);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(40);
    expect(await raced).toBe("ok");
  });
});
