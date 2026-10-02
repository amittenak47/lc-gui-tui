import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion, type PanInfo } from "motion/react";
import { setNotificationReducedMotion, dismissNotification, dismissNotificationDeck, setNotificationsExpanded, notificationSnapshot, subscribeNotifications } from "../util/notifications";

export const NOTIFICATION_FOLD_MS = 5000;
export const NOTIFICATION_HOLD_MS = 500;

export function NotificationStack() {
  const entries = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [topHeight, setTopHeight] = useState(48);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ x: number; y: number } | null>(null);
  const skipTap = useRef(false);
  const topRef = useRef<HTMLDivElement>(null);
  const fold = () => { setExpanded(false); setNotificationsExpanded(false); };
  const keepOpen = () => {
    clearTimeout(idleTimer.current);
    if (expanded) idleTimer.current = setTimeout(fold, NOTIFICATION_FOLD_MS);
  };
  useEffect(() => {
    setNotificationsExpanded(expanded);
    keepOpen();
    return () => clearTimeout(idleTimer.current);
  }, [expanded, entries]);
  useEffect(() => {
    if (!entries.length) setExpanded(false);
  }, [entries.length]);
  useEffect(() => () => {
    clearTimeout(idleTimer.current);
    clearTimeout(holdTimer.current);
    setNotificationsExpanded(false);
  }, []);
  useLayoutEffect(() => {
    const node = topRef.current;
    if (!node) return;
    const measure = () => setTopHeight(node.offsetHeight || 48);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [entries[0]?.id]);
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
  const swipe = (info: PanInfo, id?: number) => {
    clearTimeout(holdTimer.current);
    skipTap.current = true;
    if (info.offset.x < -60 || (info.offset.x < -15 && info.velocity.x < -500)) {
      if (id == null) dismissNotificationDeck(); else dismissNotification(id);
    }
    setNotificationsExpanded(expanded);
    keepOpen();
  };
  const exitX = -(Math.max(270, topRef.current?.getBoundingClientRect().width ?? 0) + (ref.current?.getBoundingClientRect().left ?? 8) + 32);
  return createPortal(<motion.div ref={ref}
    className={`lc-notification-stack${expanded ? " is-expanded" : " is-folded"}`}
    style={{ height: expanded || !entries.length ? "auto" : topHeight + (entries.length - 1) * 7 }}
    layout={!reduced} aria-label="Canvas notifications"
    drag={!expanded && entries.length > 0 ? "x" : false}
    dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: .65, right: 0 }} dragMomentum={false}
    onDragStart={() => { clearTimeout(holdTimer.current); skipTap.current = true; setNotificationsExpanded(true); }}
    onDragEnd={(_, info) => swipe(info)}
    onPointerDownCapture={keepOpen} onKeyDownCapture={event => { keepOpen(); if (event.key === "Escape") fold(); }}>
      {/* Every message is announced, including cards concealed beneath the top one. */}
      <div className="lc-notification-announcer" role="status" aria-live="polite" aria-relevant="additions">
        {entries.filter(entry => !entry.exiting).map(entry => <div key={entry.id}>{entry.text}</div>)}
      </div>
      {entries.map((entry, index) => <motion.div key={entry.id} ref={index === 0 ? topRef : undefined}
        className="lc-notification" layout={!reduced}
        style={{ position: expanded ? "relative" : "absolute", top: expanded ? 0 : index * 7, height: !expanded && index > 0 ? topHeight : undefined, zIndex: entries.length - index, width: "100%", transformOrigin: "top center" }}
        inert={entry.exiting || (!expanded && index > 0) || undefined}
        initial={reduced ? false : { opacity: 0, y: 12, scale: .96 }}
        animate={{ opacity: entry.exiting ? 0 : 1, x: entry.exiting && !reduced ? exitX : 0, y: 0, scale: expanded ? 1 : 1 - index * .035 }}
        transition={{ duration: reduced ? 0 : entry.fast ? .12 : .22 }}
        drag={expanded && !entry.exiting ? "x" : false} dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: .65, right: 0 }} dragMomentum={false}
        onDragStart={() => { clearTimeout(holdTimer.current); skipTap.current = true; }}
        onDragEnd={(_, info) => swipe(info, entry.id)}
        onPointerDown={event => {
          if (index !== 0 || event.button !== 0 || (event.target as HTMLElement).closest(".lc-notification-dismiss")) return;
          skipTap.current = false;
          press.current = { x: event.clientX, y: event.clientY };
          holdTimer.current = setTimeout(() => { skipTap.current = true; fold(); }, NOTIFICATION_HOLD_MS);
        }}
        onPointerMove={event => {
          if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) clearTimeout(holdTimer.current);
        }}
        onPointerUp={() => { clearTimeout(holdTimer.current); press.current = null; }}
        onPointerCancel={() => { clearTimeout(holdTimer.current); press.current = null; }}
        onContextMenu={event => event.preventDefault()}>
        <button type="button" className="lc-notification-message"
          aria-expanded={entries.length > 1 ? expanded : undefined}
          onClick={() => {
            if (skipTap.current) { skipTap.current = false; return; }
            if (!expanded) { setNotificationsExpanded(true); setExpanded(true); }
          }}>
          <span>{entry.text}</span>
          {!expanded && index === 0 && entries.length > 1 && <small className="lc-notification-count" aria-label={`${entries.length} notifications`}>{entries.length}</small>}
        </button>
        <button type="button" className="lc-notification-dismiss" aria-label={expanded ? "Dismiss notification" : "Dismiss notification stack"}
          onClick={() => expanded ? dismissNotification(entry.id) : dismissNotificationDeck()}>×</button>
      </motion.div>)}
  </motion.div>, document.body);
}
