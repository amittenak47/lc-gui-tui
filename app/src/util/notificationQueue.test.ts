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

it("lets each notice slide off on its own clock while the rest stay", () => {
  const a = queue.show("a", 1400); const b = queue.show("b", 3000);
  vi.advanceTimersByTime(1400);
  expect(queue.snapshot().find(n => n.id === a)?.exiting).toBe(true);
  expect(live()).toEqual([b]);
  vi.advanceTimersByTime(220);
  expect(ids()).toEqual([b]);
  vi.advanceTimersByTime(3000);
  expect(ids()).toEqual([]);
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
