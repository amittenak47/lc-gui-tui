/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReadingPage, saveReadingPage } from "./readingPosition";

describe("readingPosition", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    });
  });

  it("brings back the page a document was last read at", () => {
    expect(loadReadingPage("doc-1")).toBe(0);
    saveReadingPage("doc-1", 67);
    saveReadingPage("doc-2", 3);
    expect(loadReadingPage("doc-1")).toBe(67);
    expect(loadReadingPage("doc-2")).toBe(3);
  });

  it("leaves the page to a session saved after the reading", () => {
    saveReadingPage("doc-1", 67);
    expect(loadReadingPage("doc-1", Date.now() - 60_000)).toBe(67);
    expect(loadReadingPage("doc-1", Date.now() + 60_000)).toBe(0);
  });

  it("ignores a missing document or a page before the first", () => {
    saveReadingPage(null, 5);
    saveReadingPage("doc-1", 0);
    expect(loadReadingPage("doc-1")).toBe(0);
    expect(loadReadingPage(undefined)).toBe(0);
  });
});
