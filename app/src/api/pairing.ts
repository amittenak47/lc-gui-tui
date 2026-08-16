/**
 * Base URL used only to build request paths in the HTTP client.
 *
 * On Tauri the router is in-process — `lcFetch` dispatches by path and never
 * opens a TCP connection. `baseUrl` stays as a dummy for URL construction.
 */

const STORAGE_KEY = "whiteboard.pairing";

export interface Pairing {
  baseUrl: string;
  token: string | null;
}

export const DEFAULT_PAIRING: Pairing = {
  baseUrl: "http://127.0.0.1:7878",
  token: null,
};

/**
 * Parse a legacy QR payload: `http://<host>:<port>?token=<token>`.
 *
 * Returns null rather than throwing, because the input is whatever the camera
 * happened to decode. LAN pairing is no longer used by the GUI.
 */
export function parsePairingUrl(raw: string): Pairing | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const token = url.searchParams.get("token");
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    token: token && token.length > 0 ? token : null,
  };
}

/** Always loopback — in-process router; ignore stale LAN pairing in storage. */
export function loadPairing(_storage: Storage | undefined = globalThis.localStorage): Pairing {
  return DEFAULT_PAIRING;
}

export function savePairing(
  pairing: Pairing,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(pairing));
}

export function clearPairing(storage: Storage | undefined = globalThis.localStorage): void {
  storage?.removeItem(STORAGE_KEY);
}

/**
 * WebSocket URL for the ambient coach (browser / unit tests only).
 *
 * Tauri uses {@link createTauriCoachSocket} and Tauri events instead.
 */
export function coachSocketUrl(pairing: Pairing): string {
  const url = new URL("/coach/session", pairing.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (pairing.token) url.searchParams.set("token", pairing.token);
  return url.toString();
}
