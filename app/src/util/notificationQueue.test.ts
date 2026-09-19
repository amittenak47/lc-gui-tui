import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationQueue } from "./notificationQueue";
let queue: NotificationQueue;
beforeEach(() => { vi.useFakeTimers(); queue = new NotificationQueue(); });
afterEach(() => { queue.dispose(); vi.useRealTimers(); });
it("keeps duplicates and waits for exit before the next message", () => {
  const a = queue.show("Saved"); const b = queue.show("Saved"); expect(a).not.toBe(b);
  expect(queue.snapshot().map(n => n.id)).toEqual([a]);
  vi.advanceTimersByTime(2200); expect(queue.snapshot()[0].exiting).toBe(true);
  vi.advanceTimersByTime(219); expect(queue.snapshot()[0].id).toBe(a);
  vi.advanceTimersByTime(1); expect(queue.snapshot()[0].id).toBe(b);
});
it("drains a flood in order without dropping messages and speeds up the exit", () => {
  const seen: number[] = []; queue.subscribe(() => { const n = queue.snapshot()[0]; if (n && !n.exiting) seen.push(n.id); });
  const ids = Array.from({ length: 12 }, (_, i) => queue.show(`Notice ${i}`, 5000));
  vi.advanceTimersByTime(450); expect(queue.snapshot()[0]).toMatchObject({ exiting: true, fast: true });
  vi.advanceTimersByTime(120); expect(queue.snapshot()[0].id).toBe(ids[1]);
  vi.runAllTimers(); expect(seen).toEqual(ids); expect(queue.snapshot()).toEqual([]);
});
it("dismissal and reduced motion do not reorder remaining notifications", () => {
  queue.setReducedMotion(true); const a = queue.show("a"); const b = queue.show("b"); const c = queue.show("c");
  queue.dismiss(b); queue.dismiss(a); vi.advanceTimersByTime(0);
  expect(queue.snapshot()[0].id).toBe(c);
});
