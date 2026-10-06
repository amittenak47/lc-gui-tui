import { afterEach, expect, it, vi } from "vitest";
import { waitForConflictUi, type ConflictUiLifecycle } from "./conflictUiWait";

afterEach(() => vi.useRealTimers());

it("fails after three seconds if the merge UI never mounts and dismisses its stale request", async () => {
  vi.useFakeTimers();
  let lifecycle!: ConflictUiLifecycle;
  const waiting = waitForConflictUi((value) => { lifecycle = value; return new Promise(() => {}); }, new AbortController().signal, "newer copy");
  const check = expect(waiting).rejects.toThrow("newer copy");
  await vi.advanceTimersByTimeAsync(3_000);
  await check;
  expect(lifecycle.signal.aborted).toBe(true);
});

it("lets the reader take as long as needed once mounted", async () => {
  vi.useFakeTimers();
  let choose!: (value: string) => void;
  const waiting = waitForConflictUi((lifecycle) => {
    lifecycle.onMounted();
    return new Promise<string>((resolve) => { choose = resolve; });
  }, new AbortController().signal, "failed");
  await vi.advanceTimersByTimeAsync(60_000);
  choose("server");
  await expect(waiting).resolves.toBe("server");
});

it("fails when a mounted window disappears", async () => {
  let lifecycle!: ConflictUiLifecycle;
  const waiting = waitForConflictUi((value) => { lifecycle = value; value.onMounted(); return new Promise(() => {}); }, new AbortController().signal, "window closed");
  lifecycle.onUnavailable();
  await expect(waiting).rejects.toThrow("window closed");
});

it("fails immediately with no handler or a thrown handler", async () => {
  await expect(waitForConflictUi(undefined, new AbortController().signal, "no UI")).rejects.toThrow("no UI");
  await expect(waitForConflictUi(() => { throw new Error("mount failed"); }, new AbortController().signal, "no UI")).rejects.toThrow("mount failed");
});

it("aborts a pending choice and removes its mount timeout", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const waiting = waitForConflictUi(() => new Promise(() => {}), abort.signal, "failed");
  abort.abort();
  await expect(waiting).rejects.toThrow("Sync stopped");
  expect(vi.getTimerCount()).toBe(0);
});
