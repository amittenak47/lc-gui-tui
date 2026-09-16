import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/** Animate the actual height so neighbouring content moves with the fold. */
export function AnimatedDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  return <AnimatePresence initial={false}>
    {open && <motion.div key="body" className="lc-animated-disclosure"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}>
      <div className="lc-animated-disclosure-content">{children}</div>
    </motion.div>}
  </AnimatePresence>;
}
