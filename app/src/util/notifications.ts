import { loadNotificationCards } from "./notificationCardsPref";
import { NotificationQueue } from "./notificationQueue";
export type { Notification } from "./notificationQueue";
const queue = new NotificationQueue();
export const notificationSnapshot = queue.snapshot;
export const subscribeNotifications = queue.subscribe;
export const dismissNotification = (id: number) => queue.dismiss(id);
export const dismissNotificationDeck = () => queue.dismissDeck();
export const setNotificationsExpanded = (value: boolean) => queue.setExpanded(value);
/**
 * Post a card. Returns -1 when cards are switched off in Settings, or when
 * `dedupe` is set and the same text is already on screen or waiting, so a
 * repeated status (e.g. offline) never stacks copies of itself.
 */
export const showNotification = (text: string, duration = 2200, opts?: { dedupe?: boolean }) => {
  if (!loadNotificationCards()) return -1;
  if (opts?.dedupe && queue.has(text)) return -1;
  return queue.show(text, duration);
};
export const setNotificationReducedMotion = (value: boolean) => queue.setReducedMotion(value);
