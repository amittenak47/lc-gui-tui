import { NotificationQueue } from "./notificationQueue";
export type { Notification } from "./notificationQueue";
const queue = new NotificationQueue();
export const notificationSnapshot = queue.snapshot;
export const subscribeNotifications = queue.subscribe;
export const dismissNotification = (id: number) => queue.dismiss(id);
export const showNotification = (text: string, duration = 2200) => queue.show(text, duration);
export const setNotificationReducedMotion = (value: boolean) => queue.setReducedMotion(value);
