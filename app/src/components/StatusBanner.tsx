import { useEffect, useState } from "react";

export interface StatusBannerProps {
  /** Banner copy. `null` triggers the exit crunch, then unmount. */
  text: string | null;
  variant: "error" | "notice";
}

/** Keep in sync with `.lc-banner-slot` / `.lc-banner` open transition. */
export const BANNER_IN_MS = 220;

/**
 * Resolve once top status banners are idle (open motion done, or none).
 *
 * Pad title and other board-open chrome sit in the same strip. They wait so
 * they start *after* a notice like "Agent off" has finished sliding in.
 */
export async function waitForTopBannersIdle(): Promise<void> {
  if (typeof document === "undefined") return;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  const overlay = document.querySelector(".lc-chrome-overlay-top");
  if (!overlay) return;
  const nodes: Element[] = [
    overlay,
    ...overlay.querySelectorAll(".lc-banner-slot, .lc-banner"),
  ];
  const waits: Promise<unknown>[] = [];
  for (const node of nodes) {
    if (typeof node.getAnimations !== "function") continue;
    for (const anim of node.getAnimations()) {
      waits.push(anim.finished.catch(() => undefined));
    }
  }
  if (waits.length === 0) return;
  await Promise.race([
    Promise.all(waits),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, BANNER_IN_MS + 80);
    }),
  ]);
}

/**
 * Header status strip — opens and closes with a short slide + height crunch.
 */
export function StatusBanner({ text, variant }: StatusBannerProps) {
  const [visible, setVisible] = useState(Boolean(text));
  const [message, setMessage] = useState(text ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (text) {
      setMessage(text);
      setVisible(true);
      // Next frame so the 0fr → 1fr transition runs.
      const id = window.requestAnimationFrame(() => setOpen(true));
      return () => window.cancelAnimationFrame(id);
    }
    if (!visible) return;
    setOpen(false);
  }, [text, visible]);

  // Reduced-motion (or missed transitionend) still clears the slot after close.
  useEffect(() => {
    if (open || !visible || text) return;
    const timer = window.setTimeout(() => setVisible(false), 280);
    return () => window.clearTimeout(timer);
  }, [open, visible, text]);

  if (!visible) return null;

  const tone = variant === "error" ? "lc-warning lc-banner" : "lc-banner lc-notice";

  return (
    <div
      className={open ? "lc-banner-slot is-open" : "lc-banner-slot"}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows") return;
        if (!open) setVisible(false);
      }}
    >
      <div className="lc-banner-slot-inner">
        <div className={tone} role="status">
          <span>{message}</span>
        </div>
      </div>
    </div>
  );
}
