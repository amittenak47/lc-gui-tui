/** Touch origins survive a page corner consuming its first pointerdown. */
const touches = new Map<number, { x: number; y: number; target: EventTarget | null }>();

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target });
    }
  }, true);
  window.addEventListener("pointermove", event => {
    const touch = touches.get(event.pointerId);
    if (touch) { touch.x = event.clientX; touch.y = event.clientY; }
  }, true);
  const release = (event: PointerEvent) => {
    // Page turns send a synthetic cancel to stop one-finger handlers. The
    // finger is still down, and remains available to start a pinch.
    if (event.type === "pointerup" || event.isTrusted) touches.delete(event.pointerId);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", () => touches.clear());
}

export function touchPointersIn(root: Element): Map<number, { x: number; y: number }> {
  return new Map([...touches].filter(([, touch]) => touch.target instanceof Node && root.contains(touch.target))
    .map(([id, touch]) => [id, { x: touch.x, y: touch.y }]));
}
