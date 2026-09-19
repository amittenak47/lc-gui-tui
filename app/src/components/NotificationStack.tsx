import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { setNotificationReducedMotion, dismissNotification, notificationSnapshot, subscribeNotifications } from "../util/notifications";

export function NotificationStack() {
  const entries = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  const reduced = useReducedMotion();
  useEffect(() => setNotificationReducedMotion(Boolean(reduced)), [reduced]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const header = document.querySelector(".lc-header");
    const place = () => {
      if (!ref.current || !header) return;
      const box = header.getBoundingClientRect();
      ref.current.style.top = `${box.bottom + 8}px`;
      ref.current.style.left = `${box.left + 8}px`;
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (header) observer?.observe(header);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, []);
  return createPortal(<div ref={ref} className="lc-notification-stack" aria-live="polite" aria-relevant="additions">

      {entries.map((entry) => <motion.div key={entry.id} className="lc-notification"
        initial={reduced ? false : { opacity: 0, y: 18, scale: 0.96 }}
        animate={entry.exiting ? { opacity: 0, x: reduced ? 0 : -300, y: 0, scale: 1 } : { opacity: 1, y: 0, x: 0, scale: 1 }}
        transition={{ duration: reduced ? 0 : entry.fast ? .12 : .22 }}>
        <span>{entry.text}</span>
        <button type="button" aria-label="Dismiss notification" onClick={() => dismissNotification(entry.id)}>×</button>
      </motion.div>)}

  </div>, document.body);
}
