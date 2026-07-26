/**
 * Where the daemon is, and the token to reach it.
 *
 * On the tablet this comes from scanning the QR that `lc serve --lan` prints;
 * on desktop it defaults to loopback with no token. Stored in localStorage so
 * pairing is a once-ever step.
 */

const STORAGE_KEY = "lc.pairing";

export interface Pairing {
  baseUrl: string;
  token: string | null;
}

export const DEFAULT_PAIRING: Pairing = {
  baseUrl: "http://127.0.0.1:7878",
  token: null,
};

/**
 * Parse the QR payload: `http://<host>:<port>?token=<token>`.
 *
 * Returns null rather than throwing, because the input is whatever the camera
 * happened to decode.
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

export function loadPairing(storage: Storage | undefined = globalThis.localStorage): Pairing {
  if (!storage) return DEFAULT_PAIRING;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PAIRING;
  try {
    const parsed = JSON.parse(raw) as Partial<Pairing>;
    if (typeof parsed.baseUrl !== "string") return DEFAULT_PAIRING;
    return { baseUrl: parsed.baseUrl, token: parsed.token ?? null };
  } catch {
    return DEFAULT_PAIRING;
  }
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
 * WebSocket URL for the ambient coach.
 *
 * The browser WebSocket API cannot set headers, so the token rides in the query
 * string here — the daemon accepts it either way. It never leaves the LAN.
 */
export function coachSocketUrl(pairing: Pairing): string {
  const url = new URL("/coach/session", pairing.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (pairing.token) url.searchParams.set("token", pairing.token);
  return url.toString();
}
