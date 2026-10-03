/**
 * Whether any ink tile layer still has squares to paint.
 *
 * A PDF page's selectable text is built by pdf.js measuring every word on the
 * UI thread: seconds on a dense page. Built while the ink was still arriving,
 * it froze the screen before the handwriting showed. The text waits for the
 * ink instead (`waitForInkSettled`), up to a cap, so the page and its ink come
 * first and selection follows.
 */

interface InkTileWork {
  readonly inkBusy: boolean;
}

const layers = new Set<InkTileWork>();

export function registerInkTileWork(layer: InkTileWork): () => void {
  layers.add(layer);
  return () => layers.delete(layer);
}

export function inkTilesBusy(): boolean {
  for (const layer of layers) if (layer.inkBusy) return true;
  return false;
}

/** Resolves once no layer has tiles queued or in flight, or after `capMs`. */
export function waitForInkSettled(capMs: number, pollMs = 100): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!inkTilesBusy() || Date.now() - started >= capMs) resolve();
      else setTimeout(check, pollMs);
    };
    check();
  });
}
