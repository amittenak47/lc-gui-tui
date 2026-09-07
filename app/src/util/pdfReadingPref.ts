/**
 * Device-local reading prefs: PDF flick coast and the live/pred/err pill.
 *
 * The pill is diagnostic chrome for flick-end prediction. It stays on until
 * Settings turns it off, matching the overlay that already shipped.
 *
 * Momentum is 0–100. 0 lifts to a dead stop. 50 is the shipping coast.
 * 100 is a long glide (~12× that travel). The closed-form predictor and the
 * rAF stepper must share {@link pdfFlickFriction} or the HUD and the page
 * disagree.
 */

import { PAN_FRICTION } from "../canvas/flickPredict";

const HUD_KEY = "whiteboard.pdfFlickHud.v1";
const MOMENTUM_KEY = "whiteboard.pdfFlickMomentum.v1";

export const PDF_FLICK_HUD_DEFAULT = true;

export const PDF_FLICK_MOMENTUM_MIN = 0;
export const PDF_FLICK_MOMENTUM_MAX = 100;
export const PDF_FLICK_MOMENTUM_DEFAULT = 50;
/** Coast length at dial 100, as a multiple of the shipping (50) travel. */
export const PDF_FLICK_TRAVEL_AT_MAX = 12;
/** Short glide at dial 1, as a multiple of shipping travel. */
export const PDF_FLICK_TRAVEL_AT_ONE = 0.12;

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
 * How far a flick coasts vs the shipping feel. 0 is a dead stop.
 * Inverse of {@link pdfFlickFriction} / {@link PAN_FRICTION}.
 */
export function pdfFlickTravelScale(momentum = loadPdfFlickMomentum()): number {
  const m = clampMomentum(momentum);
  if (m <= 0) return 0;
  if (m <= 50) {
    const t = (m - 1) / 49;
    return PDF_FLICK_TRAVEL_AT_ONE + t * (1 - PDF_FLICK_TRAVEL_AT_ONE);
  }
  const t = (m - 50) / 50;
  return 1 + t * (PDF_FLICK_TRAVEL_AT_MAX - 1);
}

/**
 * Exponential friction per ms for the hand-pan coast.
 *
 * 0 on the dial is no coast (`0`, and Board must not start inertia — `exp(0)`
 * would never slow). 50 is {@link PAN_FRICTION}. 100 is a long glide.
 */
export function pdfFlickFriction(momentum = loadPdfFlickMomentum()): number {
  const scale = pdfFlickTravelScale(momentum);
  if (!(scale > 0)) return 0;
  return PAN_FRICTION / scale;
}
