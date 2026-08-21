/**
 * How much longer the embedding pass has to run — measured, never guessed.
 *
 * Nothing is claimed before the first batch returns. Per-request latency
 * depends on the model, the machine and whether the weights were resident, and
 * a number invented from any of those is exactly the sort of confident fiction
 * this whole change set exists to remove: a bar that said "about a minute" for
 * ten minutes would be worse than one that said nothing.
 *
 * After the first batch there is a real rate, so the estimate is arithmetic.
 * It is re-derived from a short window rather than from the whole run, because
 * a machine speeds up once a model is resident and slows down when something
 * else wants the GPU, and an average over everything since the start would
 * chase neither.
 */

/** Samples kept for the rate. Enough to smooth a stutter, few enough to follow. */
export const ETA_WINDOW = 5;

export interface EtaSample {
  /** Chunks finished by this batch. */
  chunks: number;
  /** How long that batch took, in milliseconds. */
  ms: number;
}

export interface EtaState {
  samples: EtaSample[];
}

export function newEta(): EtaState {
  return { samples: [] };
}

export function recordBatch(state: EtaState, sample: EtaSample): EtaState {
  if (sample.chunks <= 0 || sample.ms < 0) return state;
  return { samples: [...state.samples, sample].slice(-ETA_WINDOW) };
}

/**
 * Milliseconds remaining, or null when nothing has been measured yet.
 *
 * Null is the honest answer before the first batch and the caller should show a
 * sweeping ring rather than a number.
 */
export function etaMs(state: EtaState, remaining: number): number | null {
  if (remaining <= 0) return 0;
  const chunks = state.samples.reduce((sum, s) => sum + s.chunks, 0);
  const ms = state.samples.reduce((sum, s) => sum + s.ms, 0);
  if (chunks <= 0 || ms <= 0) return null;
  return Math.round((ms / chunks) * remaining);
}

/** A short human phrase for a duration, or null when there is nothing to say. */
export function etaLabel(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"} left`;
}
