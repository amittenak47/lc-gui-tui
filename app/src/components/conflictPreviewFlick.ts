/**
 * Mouse-drag coast on a conflict pane's paper stack.
 *
 * Touch and pen use native `overflow` + `touch-action: pan-y`. JS flick used
 * to `preventDefault` and `setPointerCapture` on those pointers, which killed
 * native scroll and ate Keep / Drop taps after a gesture.
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

  const isMouse = (event: PointerEvent) =>
    event.pointerType === "mouse" || event.pointerType === "";

  const onDown = (event: PointerEvent) => {
    if (!isMouse(event) || event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest?.("button, .lc-hub-conflict-list")) {
      return;
    }
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
    }
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
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  return () => {
    stopCoast();
    root.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
}
