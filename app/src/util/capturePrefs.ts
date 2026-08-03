/** Local preference: save board captures into the device image library / Downloads. */

const AUTO_KEY = "lc.capture.autoSave";
const DEST_KEY = "lc.capture.destination";

/** Where auto-saved captures go. Default: device Photos / Pictures. */
export type CaptureDestination = "photos" | "downloads" | "share";

export function loadAutoSaveCaptures(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAutoSaveCaptures(value: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadCaptureDestination(): CaptureDestination {
  try {
    const raw = localStorage.getItem(DEST_KEY);
    if (raw === "downloads" || raw === "share" || raw === "photos") return raw;
  } catch {
    /* ignore */
  }
  return "photos";
}

export function saveCaptureDestination(value: CaptureDestination): void {
  try {
    localStorage.setItem(DEST_KEY, value);
  } catch {
    /* ignore */
  }
}

async function blobToBytes(blob: Blob): Promise<number[]> {
  const buffer = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buffer));
}

async function saveViaTauri(
  blob: Blob,
  filename: string,
  destination: CaptureDestination,
): Promise<boolean> {
  if (destination === "share") return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = await blobToBytes(blob);
    await invoke<string>("save_png_bytes", {
      bytes,
      filename,
      destination: destination === "downloads" ? "downloads" : "photos",
    });
    return true;
  } catch (cause) {
    console.warn("[lc] save_png_bytes failed", cause);
    return false;
  }
}

async function saveViaShare(blob: Blob, filename: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  const nav = navigator as Navigator & {
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    canShare?: (data: { files?: File[] }) => boolean;
  };
  if (typeof nav.share !== "function") return false;
  if (nav.canShare && !nav.canShare({ files: [file] })) return false;
  try {
    await nav.share({ files: [file], title: filename });
    return true;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return true;
    return false;
  }
}

function saveViaDownloadLink(blob: Blob, filename: string): void {
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

/** Best-effort save of a PNG blob using the user's capture destination pref. */
export async function saveCaptureToDevice(blob: Blob, basename = "lc-capture"): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${basename}-${stamp}.png`;
  const destination = loadCaptureDestination();

  if (destination === "share") {
    if (await saveViaShare(blob, filename)) return;
    if (await saveViaTauri(blob, filename, "photos")) return;
    saveViaDownloadLink(blob, filename);
    return;
  }

  if (await saveViaTauri(blob, filename, destination)) return;
  // Native write failed (browser, or APK without rebuild) — share / download.
  console.warn("[lc] native capture save failed; falling back to share/download");
  if (await saveViaShare(blob, filename)) return;
  saveViaDownloadLink(blob, filename);
}
