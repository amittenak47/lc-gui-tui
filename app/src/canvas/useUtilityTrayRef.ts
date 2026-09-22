import { useCallback } from "react";

/**
 * Height of the view tray box. A wake that hangs past the tray is on the
 * other side of the ink checker, so counting it only opens a hole.
 */
export function trayVisualHeight(node: HTMLElement): number {
  const box = node.getBoundingClientRect();
  return Math.max(node.offsetHeight, Math.max(0, box.height));
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
