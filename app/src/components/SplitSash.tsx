/**
 * The bar between a split's two panes — the VS Code sash.
 *
 * Drag resizes live. Window-level pointer listeners, not button capture:
 * a parent re-render from `set-ratio` used to drop capture, so the seam
 * looked selected and the panes never moved.
 */

import { useEffect, useRef, useState } from "react";

import { clampSplitRatio, type SplitAxis } from "../util/tabs";

export function SplitSash({
  axis,
  onRatio,
}: {
  axis: SplitAxis;
  onRatio: (ratio: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const sashRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef(false);
  const onRatioRef = useRef(onRatio);
  onRatioRef.current = onRatio;
  const lastTapRef = useRef(0);

  const ratioAt = (x: number, y: number): number | null => {
    const sash = sashRef.current;
    const main = sash?.parentElement;
    if (!main) return null;
    const box = main.getBoundingClientRect();
    return clampSplitRatio(
      axis === "vertical"
        ? (x - box.left) / Math.max(1, box.width)
        : (y - box.top) / Math.max(1, box.height),
    );
  };

  const applyRatio = (x: number, y: number) => {
    const ratio = ratioAt(x, y);
    if (ratio === null) return;
    const main = sashRef.current?.parentElement;
    if (main) {
      main.style.setProperty("--lc-split-a", String(ratio));
      main.style.setProperty("--lc-split-b", String(1 - ratio));
    }
    onRatioRef.current(ratio);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      applyRatio(event.clientX, event.clientY);
    };
    const onUp = () => {
      dragRef.current = false;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.dataset.lcSashDrag = axis;
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      delete document.body.dataset.lcSashDrag;
    };
  }, [axis, dragging]);

  return (
    <button
      ref={sashRef}
      type="button"
      role="separator"
      aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
      aria-label="Resize split"
      aria-pressed={dragging}
      className={["lc-split-sash", `is-${axis}`, dragging ? "is-dragging" : ""]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const now = Date.now();
        if (now - lastTapRef.current < 320) {
          lastTapRef.current = 0;
          dragRef.current = false;
          setDragging(false);
          const main = sashRef.current?.parentElement;
          if (main) {
            main.style.setProperty("--lc-split-a", "0.5");
            main.style.setProperty("--lc-split-b", "0.5");
          }
          onRatioRef.current(0.5);
          return;
        }
        lastTapRef.current = now;
        dragRef.current = true;
        setDragging(true);
        event.preventDefault();
        event.stopPropagation();
        applyRatio(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        const main = event.currentTarget.parentElement;
        if (!main) return;
        const box = main.getBoundingClientRect();
        const span = axis === "vertical" ? box.width : box.height;
        const sash = event.currentTarget.getBoundingClientRect();
        const here = clampSplitRatio(
          axis === "vertical"
            ? (sash.left + sash.width / 2 - box.left) / Math.max(1, box.width)
            : (sash.top + sash.height / 2 - box.top) / Math.max(1, box.height),
        );
        const step = (event.shiftKey ? 40 : 12) / Math.max(1, span);
        const back = axis === "vertical" ? "ArrowLeft" : "ArrowUp";
        const forward = axis === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key === back) onRatio(clampSplitRatio(here - step));
        else if (event.key === forward) onRatio(clampSplitRatio(here + step));
        else if (event.key === "Home") onRatio(0.5);
        else return;
        event.preventDefault();
      }}
    />
  );
}
