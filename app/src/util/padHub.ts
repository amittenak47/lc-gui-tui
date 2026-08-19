/**
 * Optional LAN hub: tablet pings a desktop `pads.db` instead of its own
 * in-process copy. Empty URL = use the local invoke router.
 */

export const PAD_HUB_KEY = "whiteboard.padHub.v1";
export const PAD_SYNC_SINCE_KEY = "whiteboard.padSync.since.v1";

export interface PadHub {
  url: string;
  token: string;
}

function trimHub(raw: unknown): PadHub | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { url?: unknown; token?: unknown };
  const url = typeof row.url === "string" ? row.url.trim().replace(/\/+$/, "") : "";
  const token = typeof row.token === "string" ? row.token.trim() : "";
  if (!url || !token) return null;
  return { url, token };
}

export function loadPadHub(): PadHub | null {
  try {
    const raw = localStorage.getItem(PAD_HUB_KEY);
    if (!raw) return null;
    return trimHub(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function savePadHub(hub: PadHub | null): void {
  try {
    const next = hub ? trimHub(hub) : null;
    const prev = loadPadHub();
    if (next) localStorage.setItem(PAD_HUB_KEY, JSON.stringify(next));
    else localStorage.removeItem(PAD_HUB_KEY);
    const same = prev?.url === next?.url && prev?.token === next?.token;
    if (!same) localStorage.removeItem(PAD_SYNC_SINCE_KEY);
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
