import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HoldButton } from "../components/HoldButton";
import { HighlighterIcon, PenToolIcon, PinkEraserIcon } from "../components/MarkToolIcons";
import type { InkPresetKind } from "../util/inkToolPresets";

/** Bright Pilot G2 gel inks — black and white, then the vivid barrel colors. */
export const QUICK_INK_COLORS = [
  ["Black", "#1a1a1a"], ["White", "#ffffff"], ["Red", "#ff2d2d"],
  ["Orange", "#ff6a00"], ["Yellow", "#ffe500"], ["Green", "#00d65a"],
  ["Turquoise", "#00d4ff"], ["Blue", "#1a4dff"], ["Purple", "#7a2bff"], ["Pink", "#ff2d9a"],
] as const;

/** Nib widths for the eraser row. Geometric so each step is a different brush. */
export const QUICK_ERASER_SIZES = [8, 16, 32, 64, 128, 192, 288, 384] as const;

const KINDS: InkPresetKind[] = ["pen", "highlighter", "eraser"];
const VIEW_PAD = 8;
const MEMORY_KEY = "whiteboard.quickInk.v1";

type QuickInkMemory = { pen?: string; highlighter?: string; eraser?: number };

function loadQuickInkMemory(): QuickInkMemory {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "") as QuickInkMemory;
    const memory: QuickInkMemory = {};
    if (typeof parsed.pen === "string") memory.pen = parsed.pen;
    if (typeof parsed.highlighter === "string") memory.highlighter = parsed.highlighter;
    if (typeof parsed.eraser === "number" && (QUICK_ERASER_SIZES as readonly number[]).includes(parsed.eraser)) {
      memory.eraser = parsed.eraser;
    }
    return memory;
  } catch {
    return {};
  }
}

function saveQuickInkMemory(memory: QuickInkMemory) {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* private browsing */ }
}

export function nearestQuickEraserSize(width: number): number {
  let best: number = QUICK_ERASER_SIZES[0];
  let dist = Infinity;
  for (const size of QUICK_ERASER_SIZES) {
    const next = Math.abs(size - width);
    if (next < dist) {
      best = size;
      dist = next;
    }
  }
  return best;
}

/**
 * Dot size inside the square, as a percent of the square.
 *
 * Square-root of the width ratio: a linear dot cannot show both a small nib
 * and the full eraser inside one small square, and this still grows strictly
 * with the brush.
 */
export function quickEraserDotPercent(
  size: number,
  max: number = QUICK_ERASER_SIZES[QUICK_ERASER_SIZES.length - 1]!,
): number {
  const t = Math.min(1, Math.max(0, size / Math.max(max, 1)));
  return Math.round(Math.sqrt(t) * 82);
}

export function placeQuickInkPanel(
  anchor: Pick<DOMRect, "left" | "top" | "bottom" | "width" | "height">,
  panel: Pick<DOMRect, "width" | "height">,
  view: { width: number; height: number },
): { left: number; top: number } | null {
  if (anchor.width < 1 && anchor.height < 1) return null;
  if (panel.width < 1 || panel.height < 1) return null;
  const left = Math.max(
    VIEW_PAD,
    Math.min(anchor.left + anchor.width / 2 - panel.width / 2, view.width - panel.width - VIEW_PAD),
  );
  const above = anchor.top - panel.height - VIEW_PAD;
  const below = anchor.bottom + VIEW_PAD;
  const top = anchor.top >= panel.height + VIEW_PAD * 2 ? above : below;
  return {
    left,
    top: Math.max(VIEW_PAD, Math.min(top, view.height - panel.height - VIEW_PAD)),
  };
}

export function QuickInkControl({ kind, color, eraserWidth = 0, onPick }: {
  kind: InkPresetKind;
  color: string;
  eraserWidth?: number;
  onPick: (kind: InkPresetKind, color?: string, eraserWidth?: number) => void;
}) {
  const sizes = kind === "eraser";
  const [open, setOpen] = useState(false);
  const [memory, setMemory] = useState(loadQuickInkMemory);
  const remember = (patch: QuickInkMemory) => {
    setMemory((current) => {
      const next = { ...current, ...patch };
      saveQuickInkMemory(next);
      return next;
    });
  };
  const savedColor = kind === "pen" ? memory.pen : kind === "highlighter" ? memory.highlighter : undefined;
  const shownColor = savedColor ?? color;
  const pickedSize = nearestQuickEraserSize(memory.eraser ?? eraserWidth);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: VIEW_PAD, top: VIEW_PAD });
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      const button = anchor.current;
      const node = panel.current;
      if (!button || !node) return;
      const next = placeQuickInkPanel(button.getBoundingClientRect(), node.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (!next) return;
      setPosition((current) => (current.left === next.left && current.top === next.top ? current : next));
    };
    place();
    // Resize listeners run before the toolbar's own resize handler commits a
    // new left/top. Measuring on the next frame, and again when that style
    // lands, is what keeps the row on the button.
    const kick = () => {
      place();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener("resize", kick);
    window.addEventListener("scroll", kick, true);
    const view = window.visualViewport;
    view?.addEventListener("resize", kick);
    view?.addEventListener("scroll", kick);
    const toolbar = anchor.current?.closest(".lc-toolbar");
    const mo = toolbar ? new MutationObserver(kick) : null;
    if (toolbar) mo?.observe(toolbar, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", kick);
      window.removeEventListener("scroll", kick, true);
      view?.removeEventListener("resize", kick);
      view?.removeEventListener("scroll", kick);
      mo?.disconnect();
    };
  }, [open, kind]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); anchor.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  const close = () => { setOpen(false); anchor.current?.focus(); };
  const cycle = () => {
    const next = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length]!;
    setOpen(false);
    if (next === "eraser") onPick(next, undefined, memory.eraser);
    else onPick(next, next === "pen" ? memory.pen : memory.highlighter);
  };
  return <>
    <HoldButton label={`Quick ${kind}`}
      ariaLabel={sizes
        ? "Quick eraser: tap for sizes, hold for next tool"
        : `Quick ${kind}: tap for colors, hold for next tool`}
      className="lc-tool lc-tip-target lc-hold-icon lc-quick-ink" pressed={open}
      onMeasure={node => { anchor.current = node; }}
      onTap={() => setOpen(value => !value)}
      onConfirm={cycle}>
      {kind === "pen" ? <PenToolIcon /> : kind === "highlighter" ? <HighlighterIcon /> : <PinkEraserIcon />}
      <span className="lc-quick-ink-dot" style={{ background: kind === "eraser" ? "#f9a8d4" : shownColor }} aria-hidden />
    </HoldButton>
    {open && createPortal(
      <div ref={panel} className="lc-quick-ink-colors" style={position}
        role="group" aria-label={sizes ? "Quick eraser sizes" : "Quick ink colors"}
        onPointerDown={event => event.stopPropagation()}>
        {sizes
          ? QUICK_ERASER_SIZES.map((size) => (
            <button key={size} type="button"
              className="lc-quick-ink-swatch is-size" aria-label={`Eraser size ${size}`}
              aria-pressed={size === pickedSize}
              onClick={() => { remember({ eraser: size }); onPick("eraser", undefined, size); close(); }}>
              <span className="lc-quick-ink-eraser" style={{
                width: `${quickEraserDotPercent(size)}%`,
                height: `${quickEraserDotPercent(size)}%`,
              }} aria-hidden />
            </button>
          ))
          : QUICK_INK_COLORS.map(([name, hex]) => <button key={hex} type="button"
            className="lc-quick-ink-swatch" style={{ background: hex }} aria-label={name}
            aria-pressed={shownColor.toLowerCase() === hex}
            onClick={() => { remember(kind === "pen" ? { pen: hex } : { highlighter: hex }); onPick(kind, hex); close(); }} />)}
      </div>,
      document.body,
    )}
  </>;
}
