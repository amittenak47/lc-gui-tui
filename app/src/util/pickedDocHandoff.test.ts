import { afterEach, describe, expect, it, vi } from "vitest";

import { dropPickedDoc, handOffPickedDoc, takePickedDoc } from "./pickedDocHandoff";

const bytes = (n: number) => new ArrayBuffer(n);

afterEach(() => {
  dropPickedDoc();
  vi.useRealTimers();
});

describe("pickedDocHandoff", () => {
  it("gives the bytes to the tab they were picked for", () => {
    const picked = bytes(8);
    handOffPickedDoc("annotate-1", "h1:8", picked);

    const taken = takePickedDoc("annotate-1");
    expect(taken?.hash).toBe("h1:8");
    expect(taken?.bytes).toBe(picked);
  });

  it("is a hand-off, not a cache — the second ask gets nothing", () => {
    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    expect(takePickedDoc("annotate-1")).not.toBeNull();
    expect(takePickedDoc("annotate-1")).toBeNull();
  });

  it("does not give one tab's file to another", () => {
    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    expect(takePickedDoc("annotate-2")).toBeNull();
    // Still there for the tab it was meant for.
    expect(takePickedDoc("annotate-1")).not.toBeNull();
  });

  it("holds one file at a time, so a second pick frees the first", () => {
    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    handOffPickedDoc("annotate-2", "h2:4", bytes(4));

    expect(takePickedDoc("annotate-1")).toBeNull();
    expect(takePickedDoc("annotate-2")?.hash).toBe("h2:4");
  });

  it("expires, so a tab closed before it mounts cannot pin a textbook", () => {
    vi.useFakeTimers();
    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    vi.advanceTimersByTime(61_000);
    expect(takePickedDoc("annotate-1")).toBeNull();
  });

  it("drops an unclaimed hand-off on request", () => {
    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    dropPickedDoc("annotate-2");
    expect(takePickedDoc("annotate-1")).not.toBeNull();

    handOffPickedDoc("annotate-1", "h1:8", bytes(8));
    dropPickedDoc("annotate-1");
    expect(takePickedDoc("annotate-1")).toBeNull();
  });
});
