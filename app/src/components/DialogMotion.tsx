import type { ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from "motion/react";

/** Retain closing dialogs just for their visual exit; actions run immediately. */
export function DialogPresence({ children }: { children: ReactNode }) {
  return <AnimatePresence>{children}</AnimatePresence>;
}

export function DialogBackdrop({ exiting = false, children, style, ...props }: HTMLMotionProps<"div"> & { exiting?: boolean }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div {...props} data-dialog-exiting={exiting || !present || undefined}
    initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: exiting ? 0 : 1 }}
    exit={{ opacity: 0, transition: { duration: reduced || exiting ? 0 : 0.18 } }}
    transition={{ duration: reduced ? 0 : exiting ? 0.18 : 0.2 }}
    style={{ ...style, pointerEvents: exiting || !present ? "none" : style?.pointerEvents }}>
    {children}
  </motion.div>;
}
