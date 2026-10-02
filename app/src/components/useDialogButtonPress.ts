import { useRef, type PointerEvent, type MouseEvent } from "react";

/** Android suppresses click after a long touch; ordinary buttons still act on release. */
export function useDialogButtonPress() {
  const press = useRef<{ button: HTMLButtonElement; pointer: number; started: number } | null>(null);
  const consumed = useRef<{ button: HTMLButtonElement; until: number } | null>(null);
  return {
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
    },
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      press.current = null;
      consumed.current = null;
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (event.button !== 0 || !(button instanceof HTMLButtonElement) || button.disabled || button.classList.contains("lc-hold-reveal")) return;
      press.current = { button, pointer: event.pointerId, started: performance.now() };
    },
    onPointerCancelCapture: () => { press.current = null; },
    onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => {
      const current = press.current;
      press.current = null;
      if (!current || current.pointer !== event.pointerId || current.button.disabled || performance.now() - current.started < 450) return;
      const rect = current.button.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      // Use the existing click callback. The trusted click, if Android also emits
      // one, is consumed below; synthetic accessibility/keyboard clicks remain.
      current.button.click();
      consumed.current = { button: current.button, until: performance.now() + 500 };
      event.preventDefault();
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      const last = consumed.current;
      if (!last || !event.isTrusted || performance.now() > last.until) return;
      if (event.target instanceof Node && last.button.contains(event.target)) {
        consumed.current = null;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
