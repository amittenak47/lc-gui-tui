import type { ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";

const poses: Variants = {
  open: {
    height: "auto", opacity: 1, y: 0, scale: 1,
    visibility: "visible", overflow: "hidden",
    transitionEnd: { overflow: "visible" },
  },
  closed: {
    height: 0, opacity: 0, y: 8, scale: .94, overflow: "hidden",
    transitionEnd: { visibility: "hidden" },
  },
};

/** Keeps wake controls and portal slots attached while their tray sleeps. */
export function ChromeMotionPanel({ open, className, snap = false, delay = 0, children }: {
  open: boolean;
  className: string;
  snap?: boolean;
  delay?: number;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  return <motion.div
    className={`${className} lc-chrome-motion`}
    initial={snap || reduced ? false : "closed"}
    animate={open ? "open" : "closed"}
    variants={poses}
    transition={{
      duration: reduced || snap ? 0 : open ? .26 : .18,
      delay: reduced || snap || !open ? 0 : delay,
      ease: [.22, 1, .36, 1],
    }}
    style={{ transformOrigin: "bottom center", flexShrink: 0 }}
    inert={!open || undefined}
    aria-hidden={!open || undefined}
  >{children}</motion.div>;
}
