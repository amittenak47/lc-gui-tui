/**
 * Optional LAN hub: tablet pings a desktop `pads.db` instead of its own
 * in-process copy. Empty URL = use the local invoke router.
 */

export const PAD_HUB_KEY = "whiteboard.padHub.v1";

/**
 * The configured hub changed. Same idiom as the autosync preference.
 *
 * Anything that only exists when there is a hub — the Sync pill — has to hear
 * about it, or setting one in Settings does nothing visible until a remount.
 */
export const PAD_HUB_EVENT = "lc-pad-hub";
export const PAD_SYNC_SINCE_KEY = "whiteboard.padSync.since.v1";

export interface PadHub {
  url: string;
  token: string;
}

/**
 * The largest request body the hub will accept.
 *
 * Must match `MAX_BODY_BYTES` in `src/serve/mod.rs`; the hub sets the same
 * number as an axum `DefaultBodyLimit` and rejects anything past it. Known
 * here so a document that can never be uploaded is refused where it is picked
 * up, rather than failing on the wire and then being queued to fail again.
 *
 * Only the hub is capped. A larger PDF still opens locally.
 */
export const HUB_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * A hub address with no scheme is a relative URL, not a host.
 *
 * `fetch("192.168.1.10:7878/pads/sync")` resolves against the app's own
 * origin and quietly asks the tablet about itself, so a walk could sit on Pad
 * having never reached the PC. Settings shows the PC's address as a bare
 * `host:port` and that is what people type, so this is the normal case, not a
 * malformed one.
 */
export function normalizeHubUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

function trimHub(raw: unknown): PadHub | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { url?: unknown; token?: unknown };
  const url = typeof row.url === "string" ? normalizeHubUrl(row.url) : "";
  const token = typeof row.token === "string" ? row.token.trim() : "";
  if (!url || !token) return null;
  return { url, token };
}

/**
 * The hub this device is the host of, if it is one.
 *
 * Not persisted, and deliberately not the same thing as the hub in Settings.
 * The desktop that *is* the hub leaves Connect empty on purpose — its card
 * says "type these into the tablet" — so it had no hub URL, and everything
 * gated on one was missing there: the Sync pill never mounted, and
 * `indexFromBytes`, which is hub-HTTP only, had nowhere to go.
 *
 * Set at boot from this process's own serve port and token, so the host walks
 * over loopback against the same `pads.db` the tablet reaches across the LAN.
 */
let hostLoopback: PadHub | null = null;

export function setHostLoopback(hub: PadHub | null): void {
  const next = hub ? trimHub(hub) : null;
  const same = hostLoopback?.url === next?.url && hostLoopback?.token === next?.token;
  hostLoopback = next;
  if (!same && typeof window !== "undefined") {
    window.dispatchEvent(new Event(PAD_HUB_EVENT));
  }
}

/**
 * The hub someone typed into Settings. Storage only.
 *
 * The Connect form reads this rather than {@link loadPadHub} so the host's own
 * loopback never appears in the fields — filling them in would make the PC
 * look like it was connecting to some other machine.
 */
export function loadSavedPadHub(): PadHub | null {
  try {
    const raw = localStorage.getItem(PAD_HUB_KEY);
    if (!raw) return null;
    return trimHub(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** The hub to talk to: whatever was saved, else this device's own loopback. */
export function loadPadHub(): PadHub | null {
  return loadSavedPadHub() ?? hostLoopback;
}

export function savePadHub(hub: PadHub | null): void {
  try {
    const next = hub ? trimHub(hub) : null;
    const prev = loadSavedPadHub();
    if (next) localStorage.setItem(PAD_HUB_KEY, JSON.stringify(next));
    else localStorage.removeItem(PAD_HUB_KEY);
    const same = prev?.url === next?.url && prev?.token === next?.token;
    if (!same) localStorage.removeItem(PAD_SYNC_SINCE_KEY);
    if (!same && typeof window !== "undefined") {
      window.dispatchEvent(new Event(PAD_HUB_EVENT));
    }
  } catch {
    /* private browsing */
  }
}

export function loadPadSyncSince(): number {
  try {
    const raw = localStorage.getItem(PAD_SYNC_SINCE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function savePadSyncSince(now: number): void {
  try {
    if (!Number.isFinite(now) || now <= 0) return;
    localStorage.setItem(PAD_SYNC_SINCE_KEY, String(Math.floor(now)));
  } catch {
    /* ignore */
  }
}
