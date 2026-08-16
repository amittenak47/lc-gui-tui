/**
 * Where the daemon is, and the token to reach it.
 *
 * On the tablet this comes from typing the **host, port and six-digit code**
 * that `lc serve --lan` prints — a tablet with only a front camera cannot scan
 * a QR off its own PC, and a 32-character token is not something anyone should
 * be asked to copy by hand. The code buys exactly one `POST /pair`, which
 * returns the long token every later request carries; scanning the QR or
 * pasting the full URL still works and lands in the same storage.
 *
 * On desktop it defaults to loopback with no token. Stored in localStorage so
 * pairing is a once-ever step.
 */

import { lcFetch } from "./nativeHttp";

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

export const DEFAULT_PORT = 7878;

/** Digits only, so "482 917" and "482-917" both pair. */
export function normalizePairCode(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Build `http://host:port` from what someone typed into two small fields.
 *
 * Tolerates a scheme, a trailing slash, and a host that already carries its own
 * port (in which case that port wins — it is the more specific thing they
 * typed). Returns null when there is nothing usable, so callers can say so
 * instead of firing a request at a malformed URL.
 */
export function pairingBaseUrl(host: string, port: string | number = DEFAULT_PORT): string | null {
  const raw = host.trim().replace(/\/+$/, "");
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const typed = String(port ?? "").trim();
  const chosen = url.port || typed || String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(chosen)) return null;
  return `${url.protocol}//${url.hostname}:${chosen}`;
}

/**
 * Trade the six-digit session code for the daemon's real token.
 *
 * `POST /pair` is the one unauthenticated write on the daemon; everything after
 * this uses the token it returns.
 */
export async function pairWithCode(
  host: string,
  port: string | number,
  code: string,
  fetchImpl: typeof fetch = lcFetch,
): Promise<Pairing> {
  const baseUrl = pairingBaseUrl(host, port);
  if (!baseUrl) {
    throw new Error("that host doesn't look right — use the Host line from the PC, e.g. 192.168.1.20");
  }
  const digits = normalizePairCode(code);
  if (digits.length !== 6) {
    throw new Error("the pairing code is the 6 digits shown by `lc serve --lan`");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: digits }),
    });
  } catch {
    throw new Error(
      `cannot reach lc serve at ${baseUrl} — is it running with --lan, and are you on the same network?`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    let message = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // Not JSON — the raw body is the best message available.
    }
    throw new Error(message || `pairing failed with status ${response.status}`);
  }

  let token: unknown;
  try {
    token = (JSON.parse(text) as { token?: unknown }).token;
  } catch {
    throw new Error("the daemon's reply to /pair was not JSON — is that really lc serve?");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("the daemon accepted the code but returned no token");
  }
  return { baseUrl, token };
}

/** Always loopback — in-process daemon; ignore stale LAN pairing in storage. */
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
