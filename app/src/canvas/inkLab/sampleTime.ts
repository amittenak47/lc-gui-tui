export type TimedSample = {
  x: number;
  y: number;
  p: number;
  t: number;
};

/**
 * Android WebView often stamps every coalesced pointer with the same
 * `timeStamp`. Fade and speed-ink read velocity from dt, so a stuck clock
 * paints every hop as a dead stop (no wash). Spread those samples over
 * wall-clock time instead of mixing `performance.now()` into event space.
 */
export function stampLiveSamples<T extends TimedSample>(
  batch: readonly T[],
  prevT: number,
  wall: number,
  prevWall = 0,
): T[] {
  if (batch.length === 0) return [];
  const last = batch[batch.length - 1]!.t;
  if (last > prevT + 0.05 || prevT <= 0) {
    let tPrev = prevT;
    return batch.map((sample) => {
      if (sample.t > tPrev + 1e-3) {
        tPrev = sample.t;
        return sample;
      }
      const t = tPrev + 1;
      tPrev = t;
      return { ...sample, t };
    });
  }
  const rawElapsed =
    Number.isFinite(wall) && Number.isFinite(prevWall) && wall > prevWall
      ? wall - prevWall
      : 0;
  const elapsed = prevWall <= 0 ? 0 : Math.min(rawElapsed, 80);
  const span = Math.max(elapsed, batch.length);
  const t0 = prevT > 0 ? prevT : Number.isFinite(wall) ? wall : 0;
  return batch.map((sample, i) => ({
    ...sample,
    t: t0 + (span * (i + 1)) / batch.length,
  }));
}
