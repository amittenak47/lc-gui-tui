import { afterEach, expect, it, vi } from "vitest";
import { isPageTurnBusy, notePageTurn, subscribePageTurnBusy } from "./pageTurnBusy";

afterEach(() => vi.useRealTimers());

it("pauses only the PDF being turned and wakes it after the last input", () => {
  vi.useFakeTimers();
  const a = vi.fn(), b = vi.fn();
  const stopA = subscribePageTurnBusy("a", a), stopB = subscribePageTurnBusy("b", b);
  notePageTurn("a");
  expect(isPageTurnBusy("a")).toBe(true);
  expect(isPageTurnBusy("b")).toBe(false);
  expect(a.mock.calls).toEqual([[true]]);
  expect(b).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  notePageTurn("a");
  vi.advanceTimersByTime(300);
  expect(isPageTurnBusy("a")).toBe(true);
  // Still a moment after the last turn, the landed page may be painted sharp.
  vi.advanceTimersByTime(150);
  expect(a.mock.calls).toEqual([[true], [false]]);
  expect(isPageTurnBusy("a")).toBe(false);
  stopA(); stopB();
});

it("removes the quiet timer when the document leaves", () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  const stop = subscribePageTurnBusy("gone", listener);
  notePageTurn("gone");
  stop();
  vi.advanceTimersByTime(2000);
  expect(listener.mock.calls).toEqual([[true]]);
  expect(isPageTurnBusy("gone")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
