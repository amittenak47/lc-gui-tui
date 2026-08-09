/**
 * Knowing when the disk said no.
 *
 * `localStorage.setItem` is the only write in the app that can fail for a
 * reason the writer can act on, and it was the only one whose failure went
 * nowhere: all three autosave paths caught it bare. The pen kept working, the
 * library kept not being written, and the loss surfaced on the way out — after
 * the session it would have saved was gone.
 *
 * So the quota failure gets a type of its own. It is deliberately *not* one of
 * the existing `*LibraryFullError`s: those are entry-count errors that fire at
 * 30 and 20 entries regardless of size, and the byte wall is always hit long
 * before either. Reporting "at most 30 documents" to someone with four is how
 * the real problem stayed invisible.
 */

/** A write that failed because the origin is out of room. */
export class StorageFullError extends Error {
  readonly code = "storage-full" as const;
  constructor(
    message = "This device is out of space for saved work",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageFullError";
  }
}

/**
 * Was this the quota, or something else?
 *
 * Browsers disagree on how to say it. Chrome and Safari throw a `DOMException`
 * named `QuotaExceededError` with code 22; Firefox uses
 * `NS_ERROR_DOM_QUOTA_REACHED` with code 1014; older WebKit reports code 22
 * with no useful name at all. Checking every form is cheaper than being wrong,
 * and being wrong here means a genuine bug gets reported as a full disk.
 */
export function isQuotaError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const { name, code } = cause as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

/**
 * `setItem`, with the quota failure named.
 *
 * Anything that is not the quota is rethrown untouched — a store that is
 * disabled entirely, or a serialisation that threw, is a different problem and
 * must not be reported as a full device.
 */
export function setStorageItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (cause) {
    if (isQuotaError(cause)) {
      throw new StorageFullError(
        "This device is out of space for saved work — delete a document or clear old sessions, then try again.",
        cause,
      );
    }
    throw cause;
  }
}

export interface StorageUsage {
  /** Bytes the origin is using, as the browser accounts for it. */
  usage: number;
  /** Bytes the origin may use before writes start failing. */
  quota: number;
  /** `usage / quota`, clamped to 0–1. `0` when the quota is unknown. */
  ratio: number;
}

/**
 * What the browser thinks this origin is using.
 *
 * Best-effort by design: `navigator.storage.estimate()` is absent in some
 * WebViews, and where it exists the numbers are deliberately coarse — the spec
 * allows padding to avoid leaking cross-origin storage. Good enough to show
 * someone that they are near the wall, not good enough to compute against.
 */
export async function estimateStorage(): Promise<StorageUsage | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return {
      usage,
      quota,
      ratio: quota > 0 ? Math.min(1, Math.max(0, usage / quota)) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ask for storage that survives pressure.
 *
 * Without this the origin is "best-effort" and the browser may evict it whole —
 * iOS drops best-effort storage after seven idle days, which for a reader who
 * annotates a textbook on holiday is the entire notebook. Granted silently on
 * an installed app or a frequently-visited origin, refused elsewhere, and a
 * refusal is not worth reporting: nothing the writer can do about it, and the
 * storage still works.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Human-readable bytes for a status line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
