/**
 * Display refresh for live ink: HUD vsync and present cap.
 * Default: avoid wasteful 120/240Hz overdraw, but never divide a 90Hz panel
 * down to 45fps. That is visibly below the 60fps floor.
 * Match display: present every dirty vsync; HUD still uses the Hz setting.
 */

export const INK_DISPLAY_HZ = [60, 90, 120, 240] as const;
export type InkDisplayHz = (typeof INK_DISPLAY_HZ)[number];
export type InkDisplayHzPref = "auto" | InkDisplayHz;

export const INK_DISPLAY_HZ_PREF_DEFAULT: InkDisplayHzPref = "auto";

/** One vsync in milliseconds. */
export function vsyncMsForHz(hz: InkDisplayHz): number {
  return 1000 / hz;
}

/** Median of positive gaps. Auto uses this so a 5ms first callback cannot pin 240Hz. */
export function medianMs(samples: readonly number[]): number {
  const xs = samples.filter((n) => n > 0 && Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return vsyncMsForHz(60);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/**
 * Snap a measured rAF gap to 60 / 90 / 120 / 240.
 */
export function snapDisplayHz(rafMs: number): InkDisplayHz {
  if (!(rafMs > 0) || !Number.isFinite(rafMs)) return 60;
  let best: InkDisplayHz = 60;
  let bestErr = Infinity;
  for (const hz of INK_DISPLAY_HZ) {
    const err = Math.abs(rafMs - vsyncMsForHz(hz));
    if (err < bestErr) {
      bestErr = err;
      best = hz;
    }
  }
  return best;
}

export function resolveDisplayHz(
  pref: InkDisplayHzPref,
  measuredRafMs: number,
): InkDisplayHz {
  if (pref !== "auto") return pref;
  return snapDisplayHz(measuredRafMs);
}

/**
 * Present at least 60fps: 60/90Hz → every vsync, 120Hz → 2, 240Hz → 4.
 * Match display skips the cap and presents every dirty vsync.
 */
export function livePresentStride(
  hz: InkDisplayHz,
  matchDisplay = false,
): number {
  if (matchDisplay) return 1;
  return Math.max(1, Math.floor(hz / 60));
}

/**
 * Composite this vsync if there is new ink or a blot is growing, and this
 * tick is on the 60fps budget (or every tick at 60Hz).
 */
export function shouldCompositeLive(
  dirty: boolean,
  hold: boolean,
  tick: number,
  stride: number,
): boolean {
  if (!dirty && !hold) return false;
  const step = Math.max(1, stride | 0);
  if (step <= 1) return true;
  return tick % step === 0;
}

/** Load-bar stall: more than two extra vsyncs (one skip is not an emergency). */
export function rafStallMs(vsyncMs: number): number {
  return vsyncMs * 3;
}
