/**
 * Wait for document fonts, but never forever.
 *
 * `document.fonts.ready` does not time out. A PDF tab that injected faces
 * Chromium never finishes loading leaves it pending, and `waitForTemplate`
 * sits on it with Home still covering the new whiteboard / practice tab.
 */
export function waitForFontsReady(timeoutMs = 1500): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return Promise.resolve();
  }
  return Promise.race([
    document.fonts.ready.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}
