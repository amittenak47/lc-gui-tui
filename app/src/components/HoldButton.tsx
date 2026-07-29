/**
 * Hold-to-confirm: a button that fills like water and only fires once it is
 * full.
 *
 * Introduced for Reveal, where an accidental tap costs you the problem. Every
 * other irreversible choice in the app now uses the same gesture — save or
 * discard on leaving, resetting the session queue, resetting the board — so
 * "this cannot be undone" always looks and feels the same, and never arrives as
 * a browser `confirm()` box.
 *
 * The mechanics live here rather than in each dialog: a rAF loop drives
 * `--lc-hold` from 0 to 1 over {@link DEFAULT_HOLD_MS}, and letting go before
 * the end resets it. Keyboard holds (Space / Enter) work the same way, so the
 * gesture is not pointer-only.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export const DEFAULT_HOLD_MS = 666;

export interface HoldButtonProps {
  /** Text on the button, and what the aria label says you are confirming. */
  label: string;
  /** Richer body (a title plus an explanation) in place of the bare label. */
  children?: ReactNode;
  onConfirm: () => void;
  /** How long the fill takes. Keep it in step with the dialog's hint text. */
  holdMs?: number;
  disabled?: boolean;
  /** Extra classes — `lc-hold-danger` tints the fill red. */
  className?: string;
  ariaLabel?: string;
  /**
   * Reset the fill when this changes — a failed confirm has to be re-held
   * rather than left sitting full.
   */
  resetKey?: unknown;
}

export function HoldButton({
  label,
  children,
  onConfirm,
  holdMs = DEFAULT_HOLD_MS,
  disabled = false,
  className,
  ariaLabel,
  resetKey,
}: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const holdingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const confirmedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const stopHold = useCallback((reset: boolean) => {
    holdingRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (reset && !confirmedRef.current) setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (!holdingRef.current) return;
    const next = Math.min(1, (performance.now() - startRef.current) / holdMs);
    setProgress(next);
    if (next >= 1) {
      holdingRef.current = false;
      confirmedRef.current = true;
      setProgress(1);
      onConfirmRef.current();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [holdMs]);

  const startHold = useCallback(() => {
    if (disabled || confirmedRef.current) return;
    holdingRef.current = true;
    startRef.current = performance.now();
    setProgress(0);
    rafRef.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  useEffect(() => () => stopHold(false), [stopHold]);

  // A rejected confirm (or a re-opened dialog) has to be held again.
  useEffect(() => {
    confirmedRef.current = false;
    setProgress(0);
  }, [resetKey]);

  useEffect(() => {
    if (disabled) stopHold(false);
  }, [disabled, stopHold]);

  return (
    <button
      type="button"
      className={className ? `lc-hold-reveal ${className}` : "lc-hold-reveal"}
      style={{ ["--lc-hold" as string]: String(progress) }}
      disabled={disabled}
      aria-label={ariaLabel ?? `Hold to confirm: ${label}`}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
        startHold();
      }}
      onPointerUp={() => stopHold(true)}
      onPointerCancel={() => stopHold(true)}
      onPointerLeave={() => {
        if (holdingRef.current) stopHold(true);
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        // Space is also "add to session picks" in the browser's TUI keys —
        // holding a dialog button must not reach it.
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (!holdingRef.current) startHold();
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.stopPropagation();
        stopHold(true);
      }}
      onBlur={() => stopHold(true)}
    >
      <span className="lc-hold-reveal-fill" aria-hidden />
      <span className="lc-hold-reveal-label">{children ?? label}</span>
    </button>
  );
}
