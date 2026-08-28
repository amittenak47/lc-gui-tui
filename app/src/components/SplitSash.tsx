/**
 * The bar between a split's two panes — the VS Code sash.
 *
 * Live resize writes CSS variables on `<main>` only. React learns the ratio
 * on pointerup. Mid-drag `set-ratio` used to re-render App and stamp the old
 * 0.5 back over the drag.
 *
 * Listeners go on `window` in the *capture* phase, from pointerdown, not from
 * a `dragging` effect. Two things that used to eat the gesture:
 *
 * 1. A parent `set-ratio` re-render dropped button pointer capture.
 * 2. Bubble-only `window` listeners never saw the move: Excalidraw (and the
 *    Android WebView) stop the event on the canvas under the finger.
 *
 * `window` only. The same handler was also bound to `document`, which does not
 * add reach — capture on `window` runs first, before anything on the page can
 * stop the event — and did mean every pointermove measured the layout, wrote
 * the CSS variables and broadcast a board resize twice.
 */

import { useEffect, useRef, useState } from "react";

import { announceSplitResize } from "../util/splitResize";
import { clampSplitRatio, type SplitAxis } from "../util/tabs";

const MOVE_OPTS: AddEventListenerOptions = { capture: true, passive: false };

function writeRatio(main: HTMLElement | null, ratio: number) {
  if (!main) return;
  main.style.setProperty("--lc-split-a", String(ratio));
  main.style.setProperty("--lc-split-b", String(1 - ratio));
}

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
  const ratioRef = useRef<number | null>(null);
  const onRatioRef = useRef(onRatio);
  onRatioRef.current = onRatio;
  const lastTapRef = useRef(0);
  const unbindRef = useRef<(() => void) | null>(null);

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

  const applyCss = (x: number, y: number) => {
    const ratio = ratioAt(x, y);
    if (ratio === null) return;
    ratioRef.current = ratio;
    writeRatio(sashRef.current?.parentElement ?? null, ratio);
    // Advisory: the panes have new widths as of this frame. A board may
    // coalesce these however it likes — `settle` below is the one that has to
    // land.
    announceSplitResize("move");
  };

  /**
   * The gesture is over and the panes are their final size.
   *
   * Said separately from the moves because it is the only part a board may not
   * skip: a `ResizeObserver` that was starved for the whole drag (Android, under
   * touch) leaves two resized panes and two boards still fitted to the old
   * halves, and nothing after this would ever tell them otherwise.
   */
  const announceSettled = () => announceSplitResize("settle");

  const unbind = () => {
    unbindRef.current?.();
    unbindRef.current = null;
    dragRef.current = false;
    setDragging(false);
    delete document.body.dataset.lcSashDrag;
  };

  /*
   * Unmount is not "the drag ended", it is "the sash is gone".
   *
   * This used to remove only the listeners. `data-lc-sash-drag` on `<body>`
   * carries `pointer-events: none !important` for every board, so a split
   * closed mid-drag left the whole canvas dead to the pointer with nothing
   * left alive to clear it. `setDragging` is left out: the component is on
   * its way out and does not need the re-render.
   */
  useEffect(
    () => () => {
      unbindRef.current?.();
      unbindRef.current = null;
      dragRef.current = false;
      delete document.body.dataset.lcSashDrag;
    },
    [],
  );

  const bindDrag = () => {
    unbindRef.current?.();
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      applyCss(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (!dragRef.current) return;
      applyCss(event.clientX, event.clientY);
      const ratio = ratioRef.current;
      unbind();
      if (ratio != null) onRatioRef.current(ratio);
      announceSettled();
    };
    window.addEventListener("pointermove", onMove, MOVE_OPTS);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    document.body.dataset.lcSashDrag = axis;
    unbindRef.current = () => {
      window.removeEventListener("pointermove", onMove, MOVE_OPTS);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  };

  return (
    <button
      ref={sashRef}
      type="button"
      role="separator"
      aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
      aria-label="Drag to resize the two panes"
      aria-pressed={dragging}
      className={["lc-split-sash", `is-${axis}`, dragging ? "is-dragging" : ""]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const now = Date.now();
        if (now - lastTapRef.current < 320) {
          lastTapRef.current = 0;
          unbind();
          writeRatio(sashRef.current?.parentElement ?? null, 0.5);
          onRatioRef.current(0.5);
          announceSettled();
          return;
        }
        lastTapRef.current = now;
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        dragRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        bindDrag();
        applyCss(event.clientX, event.clientY);
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
        let next: number | null = null;
        if (event.key === back) next = clampSplitRatio(here - step);
        else if (event.key === forward) next = clampSplitRatio(here + step);
        else if (event.key === "Home") next = 0.5;
        else return;
        event.preventDefault();
        writeRatio(main, next);
        onRatio(next);
        // Each keypress is its own finished move — there is no drag to end.
        announceSettled();
      }}
    >
      <span className="lc-split-sash-grip" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </button>
  );
}
