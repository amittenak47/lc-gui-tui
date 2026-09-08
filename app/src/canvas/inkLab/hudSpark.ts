/**
 * Tiny frame-time spark for the performance overlay. Not an FPS graph —
 * vsync caps FPS, and the spikes we care about are milliseconds.
 */

/** Default one 60 Hz vsync. Drawn as a hairline when no Hz is passed. */
export const INK_LAB_SPARK_VSYNC_MS = 1000 / 60;
/** Default clip: three 60 Hz frames. */
export const INK_LAB_SPARK_CAP_MS = INK_LAB_SPARK_VSYNC_MS * 3;

export const INK_LAB_SPARK_CSS_W = 168;
export const INK_LAB_SPARK_CSS_H = 36;

/** Hairline = one vsync. Scale of the spark = three vsyncs (stall window). */
export function sparkVsyncMs(vsyncMs?: number): number {
  return vsyncMs != null && vsyncMs > 0 ? vsyncMs : INK_LAB_SPARK_VSYNC_MS;
}

export function sparkCapMs(vsyncMs?: number): number {
  return sparkVsyncMs(vsyncMs) * 3;
}

/** One skipped beat is not red; two extra vsyncs is. */
export function sparkRedMs(vsyncMs?: number): number {
  return sparkVsyncMs(vsyncMs) * 2 + 1;
}

export function drawFrameSpark(
  canvas: HTMLCanvasElement,
  samples: readonly number[],
  vsyncMs: number = INK_LAB_SPARK_VSYNC_MS,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgb(24 24 24 / 72%)";
  ctx.fillRect(0, 0, w, h);
  if (w < 4 || h < 4) return;
  const vs = sparkVsyncMs(vsyncMs);
  const cap = sparkCapMs(vs);
  const yAt = (ms: number) => {
    const t = Math.min(cap, Math.max(0, ms)) / cap;
    return h - 2 - t * (h - 4);
  };
  ctx.strokeStyle = "rgb(244 244 245 / 28%)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yAt(vs));
  ctx.lineTo(w, yAt(vs));
  ctx.stroke();
  if (samples.length < 2) return;
  const last = samples[samples.length - 1] ?? 0;
  ctx.strokeStyle = last > sparkRedMs(vs) ? "rgb(252 165 165)" : "rgb(134 239 172)";
  ctx.beginPath();
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const x = 1 + (i / Math.max(1, n - 1)) * (w - 2);
    const y = yAt(samples[i] ?? 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
