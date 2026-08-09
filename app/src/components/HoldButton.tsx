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
 * `--lc-hold` from 0 to 1 over {@link HOLD_MS}, and letting go before the end
 * resets it. Optional {@link HoldButtonProps.onTap} fires on a short release
 * before the fill completes. Keyboard holds (Space / Enter) work the same way,
 * so the gesture is not pointer-only.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { CSSProperties } from "react";

import { HOLD_MS } from "../util/gesture";

/** @deprecated Prefer {@link HOLD_MS} from `util/gesture`. */
export const DEFAULT_HOLD_MS = HOLD_MS;

export interface HoldButtonProps {
  /** Text on the button, and what the aria label says you are confirming. */
  label: string;
  /** Richer body (a title plus an explanation) in place of the bare label. */
  children?: ReactNode;
  onConfirm: () => void;
  /**
   * Short press released before the fill completes.
   */
  onTap?: () => void;
  /** How long the fill takes. Defaults to the shared {@link HOLD_MS}. */
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
  /**
   * External fill baseline (e.g. download progress). Hold fill runs from here
   * to 1 instead of from 0.
   */
  trackProgress?: number;
  /** Shimmer fill while total is unknown. */
  fillIndeterminate?: boolean;
  /** Custom-tooltip text, for hold buttons that sit in a toolbar. */
  dataTip?: string;
  dataTipPlacement?: "top" | "bottom" | "left" | "right";
  /** Reflected as `aria-pressed`, for a hold button that toggles a mode. */
  pressed?: boolean;
  /**
   * Positioning, for a hold button the caller places itself.
   *
   * The footnote ribbons are laid out in page coordinates by the selection
   * layer; everything else here sits in ordinary flow. Merged *under* the
   * hold's own `--lc-hold`, so a caller cannot accidentally freeze the fill.
   */
  style?: CSSProperties;
  /** Reflected as a `data-region` attribute — a region mark is drawn as a box. */
  dataRegion?: boolean;
  /** The rendered node, for a caller that needs to anchor something to it. */
  onMeasure?: (node: HTMLButtonElement | null) => void;
}

export function HoldButton({
  label,
  children,
  onConfirm,
  onTap,
  holdMs = HOLD_MS,
  disabled = false,
  className,
  ariaLabel,
  resetKey,
  trackProgress = 0,
  fillIndeterminate = false,
  dataTip,
  dataTipPlacement,
  pressed,
  style,
  dataRegion,
  onMeasure,
}: HoldButtonProps) {
  const [holdProgress, setHoldProgress] = useState(0);
  const holdingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const confirmedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  const stopHold = useCallback((opts: { reset: boolean; release?: boolean }) => {
    const wasHolding = holdingRef.current;
    const wasConfirmed = confirmedRef.current;
    holdingRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (
      opts.release &&
      wasHolding &&
      !wasConfirmed &&
      onTapRef.current
    ) {
      onTapRef.current();
    }
    // Always clear the fill on release — leaving it full after confirm made
    // Offline look stuck after the gate dialog closed.
    if (opts.reset) {
      confirmedRef.current = false;
      setHoldProgress(0);
    }
  }, []);

  const displayProgress =
    holdProgress > 0
      ? Math.min(1, trackProgress + (1 - trackProgress) * holdProgress)
      : trackProgress;

  const tick = useCallback(() => {
    if (!holdingRef.current) return;
    const next = Math.min(1, (performance.now() - startRef.current) / holdMs);
    setHoldProgress(next);
    if (next >= 1) {
      holdingRef.current = false;
      confirmedRef.current = true;
      setHoldProgress(1);
      onConfirmRef.current();
      // Clear the filled look once the confirm action has run (dialog open, etc.).
      window.setTimeout(() => {
        confirmedRef.current = false;
        setHoldProgress(0);
      }, 0);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [holdMs]);

  const startHold = useCallback(() => {
    if (disabled) return;
    confirmedRef.current = false;
    holdingRef.current = true;
    startRef.current = performance.now();
    setHoldProgress(0);
    rafRef.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  useEffect(() => () => stopHold({ reset: false }), [stopHold]);

  // A rejected confirm (or a re-opened dialog) has to be held again.
  useEffect(() => {
    confirmedRef.current = false;
    setHoldProgress(0);
  }, [resetKey]);

  useEffect(() => {
    if (!holdingRef.current) setHoldProgress(0);
  }, [trackProgress]);

  useEffect(() => {
    if (disabled) stopHold({ reset: false });
  }, [disabled, stopHold]);

  return (
    <button
      type="button"
      className={[
        "lc-hold-reveal",
        fillIndeterminate ? "lc-progress-fill is-indeterminate" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      ref={onMeasure}
      style={
        fillIndeterminate && holdProgress === 0
          ? style
          : { ...style, ["--lc-hold" as string]: String(displayProgress) }
      }
      data-region={dataRegion ? "" : undefined}
      disabled={disabled}
      aria-label={
        ariaLabel ??
        (onTap ? `${label}: tap to edit, hold to confirm` : `Hold to confirm: ${label}`)
      }
      aria-busy={fillIndeterminate || (trackProgress > 0 && trackProgress < 1)}
      aria-pressed={pressed}
      data-tip={dataTip}
      data-tip-placement={dataTipPlacement}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
        startHold();
      }}
      onPointerUp={() => stopHold({ reset: true, release: true })}
      onPointerCancel={() => stopHold({ reset: true })}
      onPointerLeave={() => {
        if (holdingRef.current) stopHold({ reset: true });
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
        stopHold({ reset: true, release: true });
      }}
      onBlur={() => stopHold({ reset: true })}
    >
      <span className="lc-hold-reveal-fill" aria-hidden />
      <span className="lc-hold-reveal-label">{children ?? label}</span>
    </button>
  );
}
