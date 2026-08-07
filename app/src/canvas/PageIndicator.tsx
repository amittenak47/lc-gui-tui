/**
 * Brief page title — "Code · 2 of 6" as a scroll crosses onto a new page.
 *
 * The desktop board is one continuous scroll, so nothing on screen says which
 * page you are on or how far through the stack you are. A page turner would
 * answer that, but there is nothing to turn: the pages grow as you write on
 * them, so a fixed selector would keep pointing at the wrong place. Reading the
 * camera and naming the page you arrived at says the same thing without
 * claiming the board is paginated.
 *
 * Transient by design. It is wayfinding for the moment you cross a boundary,
 * not a permanent header — it fades once you settle in to read.
 *
 * Same imperative pattern as `ModeIndicator`: Board is heavy, and a React
 * re-render per scroll frame would be wasted work. The node mounts once and the
 * caller pushes text straight onto it.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** How long the pill lingers after the last page change. */
const HOLD_MS = 1100;

export interface PageIndicatorHandle {
  /** Name the page just scrolled onto, restarting the fade. */
  show(label: string, index: number, total: number, blurb?: string): void;
  /** Drop the pill now — leaving the board, or paging took over. */
  hide(): void;
}

export type PageIndicatorProps = Record<never, never>;

export const PageIndicator = forwardRef<PageIndicatorHandle, PageIndicatorProps>(
  function PageIndicator(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<number>(0);

    useEffect(
      () => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
      },
      [],
    );

    useImperativeHandle(
      ref,
      (): PageIndicatorHandle => ({
        show(label, index, total, blurb) {
          const node = nodeRef.current;
          if (!node) return;
          const head = document.createElement("div");
          head.className = "lc-page-indicator-head";
          head.append(titleSpan(label), countSpan(`${index + 1} of ${total}`));
          node.replaceChildren(head);
          if (blurb) {
            node.append(blurbSpan(blurb));
          }
          node.classList.add("is-visible");
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = 0;
            nodeRef.current?.classList.remove("is-visible");
          }, HOLD_MS);
        },
        hide() {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = 0;
          nodeRef.current?.classList.remove("is-visible");
        },
      }),
      [],
    );

    return <div ref={nodeRef} className="lc-page-indicator" aria-hidden />;
  },
);

function titleSpan(label: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "lc-page-indicator-title";
  span.textContent = label;
  return span;
}

function countSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "lc-page-indicator-count";
  span.textContent = text;
  return span;
}

function blurbSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "lc-page-indicator-blurb";
  span.textContent = text;
  return span;
}
