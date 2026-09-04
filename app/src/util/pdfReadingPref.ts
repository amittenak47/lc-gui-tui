/**
 * Device-local reading prefs: PDF flick coast and the live/pred/err pill.
 *
 * The pill is diagnostic chrome for flick-end prediction. It stays on until
 * Settings turns it off, matching the overlay that already shipped.
 *
 * Momentum is 0–100, 50 = the current exponential friction. Higher = longer
 * coast after a flick. The closed-form predictor and the rAF stepper must
 * share {@link pdfFlickFriction} or the HUD and the page disagree.
 */

import { PAN_FRICTION } from "../canvas/flickPredict";

const HUD_KEY = "whiteboard.pdfFlickHud.v1";
const MOMENTUM_KEY = "whiteboard.pdfFlickMomentum.v1";

export const PDF_FLICK_HUD_DEFAULT = true;

export const PDF_FLICK_MOMENTUM_MIN = 0;
export const PDF_FLICK_MOMENTUM_MAX = 100;
export const PDF_FLICK_MOMENTUM_DEFAULT = 50;

/** Fired when Settings saves, so an open board picks the new coast / HUD up. */
export const PDF_READING_EVENT = "lc-pdf-reading";

function clampMomentum(value: number): number {
  if (!Number.isFinite(value)) return PDF_FLICK_MOMENTUM_DEFAULT;
  return Math.min(PDF_FLICK_MOMENTUM_MAX, Math.max(PDF_FLICK_MOMENTUM_MIN, value));
}

export function loadPdfFlickHud(): boolean {
  try {
    const raw = localStorage.getItem(HUD_KEY);
    if (raw == null) return PDF_FLICK_HUD_DEFAULT;
    return raw !== "0";
  } catch {
    return PDF_FLICK_HUD_DEFAULT;
  }
}

export function savePdfFlickHud(on: boolean): void {
  try {
    localStorage.setItem(HUD_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}

export function loadPdfFlickMomentum(): number {
  try {
    const raw = localStorage.getItem(MOMENTUM_KEY);
    if (raw == null) return PDF_FLICK_MOMENTUM_DEFAULT;
    return clampMomentum(Number(raw));
  } catch {
    return PDF_FLICK_MOMENTUM_DEFAULT;
  }
}

export function savePdfFlickMomentum(value: number): void {
  try {
    localStorage.setItem(MOMENTUM_KEY, String(clampMomentum(value)));
  } catch {
    /* private browsing */
  }
}

/**
 * Exponential friction per ms for the hand-pan coast.
 *
 * 0 on the dial is a short stop (~2.5× shipping friction). 50 is
 * {@link PAN_FRICTION}. 100 is a long glide (~0.4×).
 */
export function pdfFlickFriction(momentum = loadPdfFlickMomentum()): number {
  const t = clampMomentum(momentum) / 50;
  const scale = t <= 1 ? 2.5 - 1.5 * t : 1 - 0.6 * (t - 1);
  return PAN_FRICTION * scale;
}
