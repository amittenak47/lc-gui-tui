import type { ReactNode } from "react";

export type TipPlacement = "top" | "bottom" | "left" | "right";

export interface TipProps {
  tip: string;
  children: ReactNode;
  className?: string;
  placement?: TipPlacement;
  /** Tried in order when `placement` does not fit. Remaining sides still follow. */
  flip?: TipPlacement[];
}

/** Hover/focus tooltip target — {@link SmartTips} renders the floating label. */
export function Tip({
  tip,
  children,
  className,
  placement = "bottom",
  flip,
}: TipProps) {
  return (
    <span
      className={className ? `lc-tip-target ${className}` : "lc-tip-target"}
      data-tip={tip}
      data-tip-placement={placement}
      data-tip-flip={flip?.join(",")}
    >
      {children}
    </span>
  );
}
