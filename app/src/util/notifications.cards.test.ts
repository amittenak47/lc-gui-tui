import { afterEach, beforeEach, expect, it, vi } from "vitest";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

it("posts cards by default and stops when they are switched off", async () => {
  const { showNotification } = await import("./notifications");
  const { saveNotificationCards, loadNotificationCards } = await import("./notificationCardsPref");
  expect(loadNotificationCards()).toBe(true);
  expect(showNotification("Linked “A” to “B”.")).toBeGreaterThan(0);
  saveNotificationCards(false);
  expect(showNotification("Linked “C” to “D”.")).toBe(-1);
  saveNotificationCards(true);
  expect(showNotification("Linked “E” to “F”.")).toBeGreaterThan(0);
});

it("does not stack a deduped notice that is already showing or waiting", async () => {
  const { showNotification } = await import("./notifications");
  const offline = "Desktop app is offline — this will sync when it's back.";
  expect(showNotification(offline, 2200, { dedupe: true })).toBeGreaterThan(0);
  expect(showNotification(offline, 2200, { dedupe: true })).toBe(-1);
  // Without dedupe the same text still posts, as before.
  expect(showNotification(offline)).toBeGreaterThan(0);
});
