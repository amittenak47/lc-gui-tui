import { useCallback } from "react";

/** Height of the view tray, including a wake that hangs below it. */
export function trayVisualHeight(node: HTMLElement): number {
  const box = node.getBoundingClientRect();
  let bottom = box.bottom;
  for (const wake of node.querySelectorAll(".lc-chrome-wake")) {
    bottom = Math.max(bottom, wake.getBoundingClientRect().bottom);
  }
  return Math.max(node.offsetHeight, Math.max(0, bottom - box.top));
}

/** CSS clearance for opposite ink/UI hands; no React updates during tray motion. */
export function useUtilityTrayRef() {
  return useCallback((node: HTMLDivElement | null) => {
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const measure = () =>
      parent.style.setProperty("--lc-utility-tray-height", `${trayVisualHeight(node)}px`);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      parent.style.removeProperty("--lc-utility-tray-height");
    };
  }, []);
}
