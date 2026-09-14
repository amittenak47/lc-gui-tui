export interface Notification { id: number; text: string }
let sequence = 0;
let entries: Notification[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const changed = () => { for (const listener of listeners) listener(); };
export const notificationSnapshot = () => entries;
export function subscribeNotifications(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function dismissNotification(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  entries = entries.filter((entry) => entry.id !== id);
  changed();
}
export function showNotification(text: string, duration = 2200): number {
  const previous = entries.find((entry) => entry.text === text);
  const id = previous?.id ?? ++sequence;
  clearTimeout(timers.get(id));
  if (!previous) entries = [...entries, { id, text }];
  while (entries.length > 4) dismissNotification(entries[0].id);
  timers.set(id, setTimeout(() => dismissNotification(id), Math.max(1400, duration)));
  changed();
  return id;
}
