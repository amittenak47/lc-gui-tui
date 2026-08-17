import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { TipPlacement } from "./Tip";

const GAP = 6;
const PAD = 8;

type TipState = {
  text: string;
  preferred: TipPlacement;
  flip: TipPlacement[] | null;
  anchor: DOMRect;
};

function isPlacement(value: string | null): value is TipPlacement {
  return value === "top" || value === "bottom" || value === "left" || value === "right";
}

function parseFlipList(raw: string | null): TipPlacement[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((item) => item.trim()).filter(isPlacement);
  return parts.length > 0 ? parts : null;
}

function place(
  anchor: DOMRect,
  width: number,
  height: number,
  placement: TipPlacement,
): { left: number; top: number } {
  switch (placement) {
    case "bottom":
      return {
        left: anchor.left + anchor.width / 2 - width / 2,
        top: anchor.bottom + GAP,
      };
    case "left":
      return {
        left: anchor.left - width - GAP,
        top: anchor.top + anchor.height / 2 - height / 2,
      };
    case "right":
      return {
        left: anchor.right + GAP,
        top: anchor.top + anchor.height / 2 - height / 2,
      };
    case "top":
    default:
      return {
        left: anchor.left + anchor.width / 2 - width / 2,
        top: anchor.top - height - GAP,
      };
  }
}

function fits(left: number, top: number, width: number, height: number): boolean {
  return (
    left >= PAD &&
    top >= PAD &&
    left + width <= window.innerWidth - PAD &&
    top + height <= window.innerHeight - PAD
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const FLIP: Record<TipPlacement, TipPlacement[]> = {
  top: ["top", "bottom", "right", "left"],
  bottom: ["bottom", "top", "right", "left"],
  left: ["left", "right", "top", "bottom"],
  right: ["right", "left", "top", "bottom"],
};

function flipOrder(preferred: TipPlacement, custom: TipPlacement[] | null): TipPlacement[] {
  if (!custom || custom.length === 0) return FLIP[preferred];
  const seen = new Set<TipPlacement>();
  const order: TipPlacement[] = [];
  for (const placement of custom) {
    if (seen.has(placement)) continue;
    seen.add(placement);
    order.push(placement);
  }
  for (const placement of FLIP[preferred]) {
    if (seen.has(placement)) continue;
    order.push(placement);
  }
  return order;
}

function positionTip(
  anchor: DOMRect,
  width: number,
  height: number,
  preferred: TipPlacement,
  custom: TipPlacement[] | null = null,
): { left: number; top: number } {
  for (const placement of flipOrder(preferred, custom)) {
    const next = place(anchor, width, height, placement);
    if (fits(next.left, next.top, width, height)) return next;
  }
  const fallback = place(anchor, width, height, preferred);
  return {
    left: clamp(fallback.left, PAD, Math.max(PAD, window.innerWidth - width - PAD)),
    top: clamp(fallback.top, PAD, Math.max(PAD, window.innerHeight - height - PAD)),
  };
}

/**
 * Viewport-aware tip layer: one floating tooltip for any `[data-tip]` control.
 * Replaces clipped CSS `::after` tips (overflow:hidden panels, screen edges).
 */
export function SmartTips() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const read = (el: HTMLElement): TipState | null => {
      const text = el.getAttribute("data-tip")?.trim();
      if (!text) return null;
      const raw = el.getAttribute("data-tip-placement");
      const preferred = isPlacement(raw) ? raw : "bottom";
      return {
        text,
        preferred,
        flip: parseFlipList(el.getAttribute("data-tip-flip")),
        anchor: el.getBoundingClientRect(),
      };
    };

    const show = (el: HTMLElement) => {
      const next = read(el);
      if (!next) return;
      targetRef.current = el;
      setTip(next);
      setCoords(null);
    };

    const hide = () => {
      targetRef.current = null;
      setTip(null);
      setCoords(null);
    };

    const onPointerOver = (event: PointerEvent) => {
      const el = (event.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el) return;
      if (el === targetRef.current) return;
      show(el);
    };

    const onPointerOut = (event: PointerEvent) => {
      const from = (event.target as Element | null)?.closest?.("[data-tip]");
      const to = (event.relatedTarget as Element | null)?.closest?.("[data-tip]");
      if (from && from !== to) hide();
    };

    const onFocusIn = (event: FocusEvent) => {
      const el = (event.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (el) show(el);
    };

    const onFocusOut = (event: FocusEvent) => {
      const from = (event.target as Element | null)?.closest?.("[data-tip]");
      const to = (event.relatedTarget as Element | null)?.closest?.("[data-tip]");
      if (from && from !== to) hide();
    };

    const onScrollOrResize = () => {
      const el = targetRef.current;
      if (!el || !document.contains(el)) {
        hide();
        return;
      }
      const next = read(el);
      if (!next) {
        hide();
        return;
      }
      setTip(next);
      setCoords(null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !nodeRef.current) return;
    const box = nodeRef.current.getBoundingClientRect();
    setCoords(positionTip(tip.anchor, box.width, box.height, tip.preferred, tip.flip));
  }, [tip]);

  if (!tip || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={nodeRef}
      className={coords ? "lc-smart-tip is-placed" : "lc-smart-tip"}
      role="tooltip"
      style={
        coords
          ? { transform: `translate3d(${Math.round(coords.left)}px, ${Math.round(coords.top)}px, 0)` }
          : undefined
      }
    >
      {tip.text}
    </div>,
    document.body,
  );
}
