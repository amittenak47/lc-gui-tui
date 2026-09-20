import { useCallback } from "react";

/** CSS clearance for opposite ink/UI hands; no React updates during tray motion. */
export function useUtilityTrayRef() {
  return useCallback((node: HTMLDivElement | null) => {
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const measure = () => parent.style.setProperty("--lc-utility-tray-height", `${node.offsetHeight}px`);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => { observer?.disconnect(); parent.style.removeProperty("--lc-utility-tray-height"); };
  }, []);
}
