import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export function useRepeatPress(
  action: () => void,
  options: { delayMs?: number; intervalMs?: number; disabled?: boolean } = {},
): {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerLeave: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
} {
  const { delayMs = 380, intervalMs = 110, disabled = false } = options;
  const actionRef = useRef(action);
  actionRef.current = action;
  const timersRef = useRef<{ delay?: number; pulse?: number }>({});

  const clear = useCallback(() => {
    const timers = timersRef.current;
    if (timers.delay != null) window.clearTimeout(timers.delay);
    if (timers.pulse != null) window.clearInterval(timers.pulse);
    timersRef.current = {};
  }, []);

  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      clear();
      actionRef.current();
      timersRef.current.delay = window.setTimeout(() => {
        timersRef.current.pulse = window.setInterval(() => {
          actionRef.current();
        }, intervalMs);
      }, delayMs);
    },
    [clear, delayMs, disabled, intervalMs],
  );

  const stop = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      clear();
    },
    [clear],
  );

  return {
    onPointerDown,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  };
}
