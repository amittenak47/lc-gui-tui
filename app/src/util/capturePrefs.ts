/**
 * Where a board capture goes, and what to tell the student afterwards.
 *
 * Saving used to be fire-and-forget: `saveCaptureToDevice` returned `void` and
 * swallowed every failure, so a capture that landed in Pictures, a capture that
 * fell back to a browser download, and a capture that failed outright all
 * looked identical — nothing happened on screen. Every path now reports what it
 * did and where, which is what the toast reads out.
 */

const AUTO_KEY = "lc.capture.autoSave";
const DEST_KEY = "lc.capture.destination";
const FOLDER_KEY = "lc.capture.folder";
const COUNTDOWN_KEY = "lc.capture.countdown";

/** Where auto-saved captures go. Default: device Photos / Pictures. */
export type CaptureDestination = "photos" | "downloads" | "folder" | "share";

/** How a capture actually left the app. */
export type CaptureOutcome =
  | "photos"
  | "downloads"
  | "folder"
  | "shared"
  | "downloaded"
  | "board-only"
  | "failed";

export interface CaptureSaveResult {
  outcome: CaptureOutcome;
  /** Filesystem path or gallery URI, when the platform gave one back. */
  path?: string;
  /** Why it failed, for the toast. */
  detail?: string;
}

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
    if (raw === "downloads" || raw === "share" || raw === "photos" || raw === "folder") {
      return raw;
    }
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

/**
 * Absolute folder for the `folder` destination.
 *
 * Typed rather than picked: a native directory picker means another Tauri
 * plugin and another permission on every platform, and on a tablet the answer
 * is nearly always one path the student sets once.
 */
export function loadCaptureFolder(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCaptureFolder(value: string): void {
  try {
    localStorage.setItem(FOLDER_KEY, value.trim());
  } catch {
    /* ignore */
  }
}

export const CAPTURE_COUNTDOWN_CHOICES = [0, 3, 5] as const;
export const CAPTURE_COUNTDOWN_DEFAULT = 3;

/** Seconds of countdown before the shutter. 0 shoots immediately. */
export function loadCaptureCountdown(): number {
  try {
    // Not `Number(getItem(...))`: an unset key is null, `Number(null)` is 0, and
    // 0 is a legal choice — so a fresh install would have read as "off".
    const raw = localStorage.getItem(COUNTDOWN_KEY);
    if (raw === null) return CAPTURE_COUNTDOWN_DEFAULT;
    const seconds = Number(raw);
    if (CAPTURE_COUNTDOWN_CHOICES.includes(seconds as never)) return seconds;
  } catch {
    /* ignore */
  }
  return CAPTURE_COUNTDOWN_DEFAULT;
}

export function saveCaptureCountdown(value: number): void {
  try {
    localStorage.setItem(COUNTDOWN_KEY, String(value));
  } catch {
    /* ignore */
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // full-board PNG, which is exactly the capture people take.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

async function tauriInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** True inside the Tauri shell (desktop window or Android app). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function saveViaTauri(
  blob: Blob,
  filename: string,
  destination: Exclude<CaptureDestination, "share">,
  folder: string,
): Promise<CaptureSaveResult | null> {
  if (!inTauri()) return null;
  try {
    const path = await tauriInvoke<string>("save_png_bytes", {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      filename,
      destination,
      directory: destination === "folder" ? folder : null,
    });
    return { outcome: destination, path };
  } catch (cause) {
    console.warn("[lc] save_png_bytes failed", cause);
    return { outcome: "failed", detail: String(cause) };
  }
}

/**
 * The Android share sheet.
 *
 * `navigator.share` is not an option in this app: the WebView is served over
 * cleartext http for the LAN daemon, and the Web Share API is gated on a secure
 * context, so it is simply undefined. The native intent goes through the same
 * plugin that already writes to MediaStore.
 */
async function shareViaTauri(blob: Blob, filename: string): Promise<CaptureSaveResult | null> {
  if (!inTauri()) return null;
  try {
    await tauriInvoke<string>("share_png_bytes", {
      payload: await blobToBase64(blob),
      filename,
    });
    return { outcome: "shared" };
  } catch (cause) {
    console.warn("[lc] share_png_bytes failed", cause);
    return null;
  }
}

async function shareViaWebApi(blob: Blob, filename: string): Promise<CaptureSaveResult | null> {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  const nav = navigator as Navigator & {
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    canShare?: (data: { files?: File[] }) => boolean;
  };
  if (typeof nav.share !== "function") return null;
  if (nav.canShare && !nav.canShare({ files: [file] })) return null;
  try {
    await nav.share({ files: [file], title: filename });
    return { outcome: "shared" };
  } catch (cause) {
    // The chooser being dismissed is a decision, not a failure to fall back on.
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { outcome: "shared" };
    }
    return null;
  }
}

function saveViaDownloadLink(blob: Blob, filename: string): CaptureSaveResult {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { outcome: "downloaded", path: filename };
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  }
}

export function captureFilename(basename = "lc-capture"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${basename}-${stamp}.png`;
}

/**
 * Save a PNG using the student's destination preference, reporting where it
 * ended up. Falls back down the chain rather than failing silently.
 */
export async function saveCaptureToDevice(
  blob: Blob,
  basename = "lc-capture",
): Promise<CaptureSaveResult> {
  const filename = captureFilename(basename);
  const destination = loadCaptureDestination();

  if (destination === "share") {
    const native = await shareViaTauri(blob, filename);
    if (native) return native;
    const web = await shareViaWebApi(blob, filename);
    if (web) return web;
    // Nothing on this platform can share; a file the student can find beats a
    // silent no-op, which is what the old code did here.
    const saved = await saveViaTauri(blob, filename, "photos", "");
    if (saved && saved.outcome !== "failed") return saved;
    return saveViaDownloadLink(blob, filename);
  }

  const folder = loadCaptureFolder();
  if (destination === "folder" && folder.length === 0) {
    return { outcome: "failed", detail: "No capture folder set — Settings → Personalise" };
  }

  const saved = await saveViaTauri(blob, filename, destination, folder);
  if (saved && saved.outcome !== "failed") return saved;

  // Browser, or a native write that was refused. Hand back a download.
  const web = await shareViaWebApi(blob, filename);
  if (web) return web;
  const link = saveViaDownloadLink(blob, filename);
  return saved?.detail ? { ...link, detail: saved.detail } : link;
}

/** One line for the toast. */
export function describeCaptureResult(result: CaptureSaveResult): string {
  switch (result.outcome) {
    case "photos":
      return result.path ? `Saved to Photos · ${shortPath(result.path)}` : "Saved to Photos";
    case "downloads":
      return result.path ? `Saved · ${shortPath(result.path)}` : "Saved to Downloads";
    case "folder":
      return result.path ? `Saved · ${shortPath(result.path)}` : "Saved to your folder";
    case "shared":
      return "Shared";
    case "downloaded":
      return result.path ? `Downloaded ${result.path}` : "Downloaded";
    case "board-only":
      return "Added to the board";
    case "failed":
      return result.detail ? `Could not save — ${result.detail}` : "Could not save";
  }
}

/** Keep the tail of a long path: the folder and the file are what identify it. */
export function shortPath(path: string, keep = 44): string {
  if (path.length <= keep) return path;
  return `…${path.slice(-(keep - 1))}`;
}
