import { useLayoutEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent } from "react";

/** Open-sheet floor: grab bar, presets, and a usable composer — not a clipped stub. */
export const AGENT_SHEET_MIN_PX = 400;

export function settleSheetHeight(height: number, available: number, initial: number, snap: boolean): number {
  const min = Math.min(AGENT_SHEET_MIN_PX, available);
  const clamped = Math.max(min, Math.min(available, height));
  if (!snap) return clamped;
  const stops = [initial, available * .25, available * .5, available * .75].map(n => Math.max(min, Math.min(available, n)));
  const nearest = stops.reduce((a, b) => Math.abs(b - clamped) < Math.abs(a - clamped) ? b : a);
  return Math.abs(nearest - clamped) <= 24 ? nearest : clamped;
}

/** Pointer samples update only the shell, once per animation frame. Geometry is
 * measured on open/resize/start, never against document content during drag. */
export function useAgentSheet(panel: RefObject<HTMLElement | null>, mobile: boolean, open: boolean, close: () => void) {
  const saved = useRef<number | null>(null);
  const available = useRef(0);
  const initial = useRef(0);
  const drag = useRef<{ id: number; y: number; height: number; next: number } | null>(null);
  const raf = useRef(0);
  const apply = (height: number) => { if (panel.current) panel.current.style.height = `${height}px`; };
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    node.inert = !open;
    if (!mobile) { node.style.cssText = ""; return; }
    const resize = () => {
      const vv = window.visualViewport;
      const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
      const headerBottom = document.querySelector(".lc-header")?.getBoundingClientRect().bottom ?? 0;
      available.current = Math.max(0, bottom - Math.max(headerBottom, vv?.offsetTop ?? 0) - 8);
      const height = drag.current?.next ?? saved.current;
      if (height != null) {
        const next = settleSheetHeight(height, available.current, initial.current || height, false);
        if (drag.current) drag.current.next = next;
        apply(next);
      } else {
        node.style.removeProperty("height");
      }
      node.style.bottom = "0px";
      node.style.maxHeight = `${available.current}px`;
      node.style.transform = open ? "translate3d(0,0,0)" : "translate3d(0,110%,0)";
      node.style.visibility = open ? "visible" : "hidden";
      node.style.pointerEvents = open ? "auto" : "none";
      node.inert = !open;
      document.documentElement.style.setProperty("--lc-agent-open", open ? "1" : "0");
      document.documentElement.style.setProperty("--lc-agent-peek", "0px");
    };
    resize();
    window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
    const header = document.querySelector(".lc-header");
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (header) observer?.observe(header);
    return () => {
      cancelAnimationFrame(raf.current); raf.current = 0; drag.current = null;
      node.style.removeProperty("transition");
      document.documentElement.style.removeProperty("--lc-agent-peek");
      window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); observer?.disconnect();
      document.documentElement.style.removeProperty("--lc-agent-open");
      document.documentElement.classList.remove("lc-agent-dragging");
    };
  }, [panel, mobile, open]);
  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (!mobile || !open || e.button !== 0 || !panel.current) return;
    e.preventDefault();
    const height = panel.current.getBoundingClientRect().height;
    initial.current ||= height;
    drag.current = { id: e.pointerId, y: e.clientY, height, next: height };
    panel.current.style.transition = "none";
    document.documentElement.classList.add("lc-agent-dragging");
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    d.next = settleSheetHeight(d.height + d.y - e.clientY, available.current, initial.current, false);
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; if (drag.current) apply(drag.current.next); });
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    cancelAnimationFrame(raf.current); raf.current = 0; drag.current = null;
    const cancel = e.type === "pointercancel" || e.type === "lostpointercapture";
    saved.current = cancel ? d.height : settleSheetHeight(d.height + d.y - e.clientY, available.current, initial.current, true);
    apply(saved.current);
    if (panel.current) panel.current.style.removeProperty("transition");
    document.documentElement.classList.remove("lc-agent-dragging");
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!cancel && Math.abs(e.clientY - d.y) < 8) close();
  };
  return { down, move, end };
}
