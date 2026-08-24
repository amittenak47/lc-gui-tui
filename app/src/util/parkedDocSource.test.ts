import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getParkedDocSource, parkDocSource } from "./parkedDocSource";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("parkedDocSource", () => {
  it("round-trips text that never reached the library", async () => {
    await parkDocSource("h-study", "# a long guide");
    expect(await getParkedDocSource("h-study")).toBe("# a long guide");
  });

  it("returns null when nothing was parked", async () => {
    expect(await getParkedDocSource("missing")).toBeNull();
  });
});
