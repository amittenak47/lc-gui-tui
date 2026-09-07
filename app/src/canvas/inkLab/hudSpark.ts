/**
 * Tiny frame-time spark for the performance overlay. Not an FPS graph —
 * vsync caps FPS, and the spikes we care about are milliseconds.
 */

/** Two 60 Hz frames. Samples above this clip at the top of the spark. */
export const INK_LAB_SPARK_CAP_MS = 1000 / 30;
/** One 60 Hz vsync. Drawn as a hairline. */
export const INK_LAB_SPARK_VSYNC_MS = 1000 / 60;

export const INK_LAB_SPARK_CSS_W = 168;
export const INK_LAB_SPARK_CSS_H = 36;

export function drawFrameSpark(
  canvas: HTMLCanvasElement,
  samples: readonly number[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgb(24 24 24 / 72%)";
  ctx.fillRect(0, 0, w, h);
  if (w < 4 || h < 4) return;
  const yAt = (ms: number) => {
    const t = Math.min(INK_LAB_SPARK_CAP_MS, Math.max(0, ms)) / INK_LAB_SPARK_CAP_MS;
    return h - 2 - t * (h - 4);
  };
  ctx.strokeStyle = "rgb(244 244 245 / 28%)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yAt(INK_LAB_SPARK_VSYNC_MS));
  ctx.lineTo(w, yAt(INK_LAB_SPARK_VSYNC_MS));
  ctx.stroke();
  if (samples.length < 2) return;
  const last = samples[samples.length - 1] ?? 0;
  ctx.strokeStyle = last > INK_LAB_SPARK_VSYNC_MS ? "rgb(252 165 165)" : "rgb(134 239 172)";
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
