import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HoldButton } from "../components/HoldButton";
import { HighlighterIcon, PenToolIcon, PinkEraserIcon } from "../components/MarkToolIcons";
import type { InkPresetKind } from "../util/inkToolPresets";

export const QUICK_INK_COLORS = [
  ["Graphite", "#242424"], ["White", "#ffffff"], ["Red", "#ef3340"],
  ["Orange", "#ff861c"], ["Yellow", "#ffd60a"], ["Green", "#18bd66"],
  ["Cyan", "#00bde3"], ["Blue", "#2979ff"], ["Violet", "#8b4dff"], ["Pink", "#f52b91"],
] as const;
const KINDS: InkPresetKind[] = ["pen", "highlighter", "eraser"];

export function QuickInkControl({ kind, color, onPick }: {
  kind: InkPresetKind;
  color: string;
  onPick: (kind: InkPresetKind, color?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const box = panel.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8));
      const top = rect.top >= box.height + 16 ? rect.top - box.height - 8 : rect.bottom + 8;
      setPosition({ left, top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
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
  return <>
    <HoldButton label={`Quick ${kind}`} ariaLabel={`Quick ${kind}: tap for colors, hold for next tool`}
      className="lc-tool lc-tip-target lc-hold-icon lc-quick-ink" pressed={open}
      dataTip={`Quick ${kind} · tap for colors · hold to cycle pen, highlighter, eraser`}
      dataTipPlacement="bottom" onMeasure={node => { anchor.current = node; }}
      onTap={() => setOpen(value => !value)}
      onConfirm={() => { setOpen(false); onPick(KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length]!); }}>
      {kind === "pen" ? <PenToolIcon /> : kind === "highlighter" ? <HighlighterIcon /> : <PinkEraserIcon />}
      <span className="lc-quick-ink-dot" style={{ background: kind === "eraser" ? "#f9a8d4" : color }} aria-hidden />
    </HoldButton>
    {open && createPortal(<div ref={panel} className="lc-quick-ink-colors" style={position}
      role="group" aria-label="Quick ink colors" onPointerDown={event => event.stopPropagation()}>
      {QUICK_INK_COLORS.map(([name, hex]) => <button key={hex} type="button"
        className="lc-quick-ink-swatch" style={{ background: hex }} aria-label={name}
        aria-pressed={kind !== "eraser" && color.toLowerCase() === hex}
        onClick={() => { onPick(kind === "eraser" ? "pen" : kind, hex); setOpen(false); anchor.current?.focus(); }} />)}
    </div>, document.body)}
  </>;
}
