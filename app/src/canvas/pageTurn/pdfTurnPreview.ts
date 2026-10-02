/** Wait for actual PDF pixels, retaining the gesture while a preview decodes. */
export function waitForPdfTurnPreview(host: Element | null, pageId: number, signal: AbortSignal): Promise<boolean> {
  const painted = () => Boolean(host && [...host.querySelectorAll<HTMLCanvasElement>(
    `[data-pdf-page="${pageId}"][data-painted] canvas.lc-pdf-canvas`,
  )].some(canvas => canvas.width > 8 && canvas.height > 8));
  if (!host || signal.aborted) return Promise.resolve(false);
  if (painted()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (ready: boolean) => {
      observer.disconnect();
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const observer = new MutationObserver(() => { if (painted()) finish(true); });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-painted", "width", "height"] });
    signal.addEventListener("abort", abort, { once: true });
  });
}
