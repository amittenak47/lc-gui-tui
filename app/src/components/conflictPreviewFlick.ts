/**
 * Finger/pen flick on a conflict pane's paper stack.
 *
 * The board owns reading-mode pan with `touch-action: none`. This overlay is
 * a plain overflow scroller, so Windows/Android will not give it the same
 * coast unless we drive `scrollTop` ourselves. Wheel stays native.
 */

import { PAN_FRICTION } from "../canvas/flickPredict";

/** px/ms — a slow drag must not coast. */
const FLICK_MIN = 0.12;
const REST_SPEED = 0.05;
/** px before the gesture is ours (so a tap can still click). */
const ARM_PX = 4;

export function attachOverflowFlick(root: HTMLElement): () => void {
  let pointerId: number | null = null;
  let lastY = 0;
  let lastT = 0;
  let velY = 0;
  let armed = false;
  let coast = 0;

  const stopCoast = () => {
    if (coast) cancelAnimationFrame(coast);
    coast = 0;
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stopCoast();
    pointerId = event.pointerId;
    lastY = event.clientY;
    lastT = event.timeStamp;
    velY = 0;
    armed = false;
  };

  const onMove = (event: PointerEvent) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    const dy = lastY - event.clientY;
    const dt = Math.max(1, event.timeStamp - lastT);
    lastY = event.clientY;
    lastT = event.timeStamp;
    if (!armed) {
      if (Math.abs(dy) < ARM_PX) return;
      armed = true;
      try {
        root.setPointerCapture(pointerId);
      } catch {
        /* capture is best-effort */
      }
    }
    event.preventDefault();
    root.scrollTop += dy;
    velY = dy / dt;
  };

  const onUp = (event: PointerEvent) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    pointerId = null;
    if (!armed || Math.abs(velY) < FLICK_MIN) return;
    let vel = velY;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(34, Math.max(1, now - prev));
      prev = now;
      root.scrollTop += vel * dt;
      vel *= Math.exp(-PAN_FRICTION * dt);
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop <= 0) {
        root.scrollTop = 0;
        coast = 0;
        return;
      }
      if (root.scrollTop >= max) {
        root.scrollTop = max;
        coast = 0;
        return;
      }
      if (Math.abs(vel) < REST_SPEED) {
        coast = 0;
        return;
      }
      coast = requestAnimationFrame(tick);
    };
    coast = requestAnimationFrame(tick);
  };

  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove, { passive: false });
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);
  return () => {
    stopCoast();
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerup", onUp);
    root.removeEventListener("pointercancel", onUp);
  };
}
