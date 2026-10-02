import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_VISIBLE, NotificationQueue } from "./notificationQueue";
let queue: NotificationQueue;
beforeEach(() => { vi.useFakeTimers(); queue = new NotificationQueue(); });
afterEach(() => { queue.dispose(); vi.useRealTimers(); });
const ids = () => queue.snapshot().map(n => n.id);
const live = () => queue.snapshot().filter(n => !n.exiting).map(n => n.id);

it("stacks notices underneath each other, newest last", () => {
  const a = queue.show("Annotation"); const b = queue.show("Scroll mode"); const c = queue.show("Saved");
  expect(ids()).toEqual([a, b, c]);
  expect(queue.snapshot().every(n => !n.exiting)).toBe(true);
});

it("holds the deck for the latest notice, then slides every card off together", () => {
  const a = queue.show("a", 1400); const b = queue.show("b", 3000);
  vi.advanceTimersByTime(1400);
  expect(live()).toEqual([a, b]);
  vi.advanceTimersByTime(1600);
  expect(queue.snapshot().every(n => n.exiting)).toBe(true);
  vi.advanceTimersByTime(220);
  expect(ids()).toEqual([]);
});

it("pauses dismissal while unfolded and gives the folded deck a fresh hold", () => {
  const a = queue.show("a"); const b = queue.show("b");
  vi.advanceTimersByTime(2000);
  queue.setExpanded(true);
  vi.advanceTimersByTime(10000);
  expect(live()).toEqual([a, b]);
  queue.setExpanded(false);
  vi.advanceTimersByTime(2199);
  expect(live()).toEqual([a, b]);
  vi.advanceTimersByTime(1);
  expect(live()).toEqual([]);
});

it("keeps unfolded cards readable during a flood and refills a dismissed middle slot", () => {
  const all = Array.from({ length: 10 }, (_, i) => queue.show(`n${i}`));
  queue.setExpanded(true);
  vi.advanceTimersByTime(10000);
  expect(live()).toEqual(all.slice(0, MAX_VISIBLE));
  queue.dismiss(all[1]);
  vi.advanceTimersByTime(220);
  expect(live()).toEqual([all[0], all[2], all[3], all[4]]);
});

it("waits for the entire exiting deck before presenting queued cards", () => {
  const all = Array.from({ length: 6 }, (_, i) => queue.show(`n${i}`));
  queue.dismissDeck();
  expect(queue.snapshot().every(n => n.exiting)).toBe(true);
  expect(ids()).toEqual(all.slice(0, MAX_VISIBLE));
  vi.advanceTimersByTime(220);
  expect(live()).toEqual(all.slice(MAX_VISIBLE));
});

it("keeps duplicates", () => {
  const a = queue.show("Saved"); const b = queue.show("Saved");
  expect(a).not.toBe(b);
  expect(ids()).toEqual([a, b]);
});

it("holds the overflow back and brings it in order as room frees up", () => {
  const all = Array.from({ length: MAX_VISIBLE + 2 }, (_, i) => queue.show(`n${i}`, 1400));
  expect(ids()).toEqual(all.slice(0, MAX_VISIBLE));
  vi.runAllTimers();
  expect(ids()).toEqual([]);
});

it("drains a flood in order without dropping messages and speeds up the exit", () => {
  const seen: number[] = [];
  queue.subscribe(() => { for (const n of queue.snapshot()) if (!n.exiting && !seen.includes(n.id)) seen.push(n.id); });
  const all = Array.from({ length: 12 }, (_, i) => queue.show(`Notice ${i}`, 5000));
  vi.advanceTimersByTime(450);
  expect(queue.snapshot()[0]).toMatchObject({ exiting: true, fast: true });
  vi.runAllTimers();
  expect(seen).toEqual(all);
  expect(queue.snapshot()).toEqual([]);
});

it("dismissal and reduced motion do not reorder remaining notifications", () => {
  queue.setReducedMotion(true);
  const a = queue.show("a"); const b = queue.show("b"); const c = queue.show("c");
  queue.dismiss(b); vi.advanceTimersByTime(0);
  expect(ids()).toEqual([a, c]);
  queue.dismiss(a); vi.advanceTimersByTime(0);
  expect(ids()).toEqual([c]);
});

it("dismissing a waiting notice drops it without showing it", () => {
  const shown = Array.from({ length: MAX_VISIBLE }, (_, i) => queue.show(`n${i}`));
  const waiting = queue.show("never");
  queue.dismiss(waiting);
  queue.dismiss(shown[0]); vi.advanceTimersByTime(220);
  expect(ids()).not.toContain(waiting);
});
