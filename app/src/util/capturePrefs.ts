/** Local preference: save board captures into the device image library / Downloads. */

const KEY = "lc.capture.autoSave";

export function loadAutoSaveCaptures(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAutoSaveCaptures(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Best-effort save of a PNG blob to the device (download / share sheet). */
export async function saveCaptureToDevice(blob: Blob, basename = "lc-capture"): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${basename}-${stamp}.png`;
  const file = new File([blob], filename, { type: blob.type || "image/png" });

  // Mobile: system share sheet often includes “Save image”.
  const nav = navigator as Navigator & {
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    canShare?: (data: { files?: File[] }) => boolean;
  };
  if (typeof nav.share === "function" && (!nav.canShare || nav.canShare({ files: [file] }))) {
    try {
      await nav.share({ files: [file], title: filename });
      return;
    } catch (cause) {
      // User cancel — don't fall through to a second save prompt.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  }
}
