import { describe, expect, it } from "vitest";

import {
  clearPairing,
  coachSocketUrl,
  DEFAULT_PAIRING,
  loadPairing,
  normalizePairCode,
  pairWithCode,
  pairingBaseUrl,
  parsePairingUrl,
  savePairing,
} from "./pairing";

/** Minimal in-memory Storage, so these tests need no DOM. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("parsePairingUrl", () => {
  it("reads the URL that `lc serve --lan` prints", () => {
    expect(parsePairingUrl("http://192.168.1.20:7878?token=abc123")).toEqual({
      baseUrl: "http://192.168.1.20:7878",
      token: "abc123",
    });
  });

  it("accepts a tokenless URL for loopback use", () => {
    expect(parsePairingUrl("http://127.0.0.1:7878")).toEqual({
      baseUrl: "http://127.0.0.1:7878",
      token: null,
    });
  });

  it("tolerates surrounding whitespace from a QR decode", () => {
    expect(parsePairingUrl("  http://10.0.0.5:7878?token=t  ")?.token).toBe("t");
  });

  it("rejects junk rather than throwing, since the input is whatever the camera saw", () => {
    for (const junk of ["", "not a url", "ftp://host/x", "javascript:alert(1)"]) {
      expect(parsePairingUrl(junk)).toBeNull();
    }
  });
});

describe("pairing storage", () => {
  it("round-trips", () => {
    const storage = memoryStorage();
    savePairing({ baseUrl: "http://host:7878", token: "tok" }, storage);
    expect(loadPairing(storage)).toEqual({ baseUrl: "http://host:7878", token: "tok" });
  });

  it("falls back to loopback when nothing is stored", () => {
    expect(loadPairing(memoryStorage())).toEqual(DEFAULT_PAIRING);
  });

  it("falls back rather than crashing on corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem("whiteboard.pairing", "{not json");
    expect(loadPairing(storage)).toEqual(DEFAULT_PAIRING);
  });

  it("clears", () => {
    const storage = memoryStorage();
    savePairing({ baseUrl: "http://host", token: "t" }, storage);
    clearPairing(storage);
    expect(loadPairing(storage)).toEqual(DEFAULT_PAIRING);
  });
});

describe("coachSocketUrl", () => {
  it("upgrades http to ws and carries the token in the query", () => {
    // The browser WebSocket API cannot set headers, hence the query parameter.
    expect(coachSocketUrl({ baseUrl: "http://192.168.1.20:7878", token: "abc" })).toBe(
      "ws://192.168.1.20:7878/coach/session?token=abc",
    );
  });

  it("upgrades https to wss", () => {
    expect(coachSocketUrl({ baseUrl: "https://host:8443", token: null })).toBe(
      "wss://host:8443/coach/session",
    );
  });

  it("omits the token when there isn't one", () => {
    expect(coachSocketUrl({ baseUrl: "http://127.0.0.1:7878", token: null })).toBe(
      "ws://127.0.0.1:7878/coach/session",
    );
  });
});

describe("pairingBaseUrl", () => {
  it("builds a base URL from the two fields on the tablet", () => {
    expect(pairingBaseUrl("192.168.1.20", "7878")).toBe("http://192.168.1.20:7878");
    expect(pairingBaseUrl("  192.168.1.20  ", 7878)).toBe("http://192.168.1.20:7878");
    expect(pairingBaseUrl("192.168.1.20")).toBe("http://192.168.1.20:7878");
  });

  it("lets a port typed into the host win — it is the more specific answer", () => {
    expect(pairingBaseUrl("192.168.1.20:9000", "7878")).toBe("http://192.168.1.20:9000");
    expect(pairingBaseUrl("http://desk.local:9000/", "7878")).toBe("http://desk.local:9000");
  });

  it("returns null for input no request should be fired at", () => {
    expect(pairingBaseUrl("", "7878")).toBeNull();
    expect(pairingBaseUrl("   ")).toBeNull();
    expect(pairingBaseUrl("192.168.1.20", "seven")).toBeNull();
  });
});

describe("normalizePairCode", () => {
  it("keeps digits, so a code read aloud in groups still pairs", () => {
    expect(normalizePairCode("482 917")).toBe("482917");
    expect(normalizePairCode("482-917")).toBe("482917");
    expect(normalizePairCode("code")).toBe("");
  });
});

describe("pairWithCode", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it("trades the six digits for the daemon's real token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ token: "long-serve-token" });
    }) as unknown as typeof fetch;

    const paired = await pairWithCode("192.168.1.20", "7878", "482 917", fetchImpl);

    expect(paired).toEqual({ baseUrl: "http://192.168.1.20:7878", token: "long-serve-token" });
    expect(calls).toEqual([
      { url: "http://192.168.1.20:7878/pair", body: { code: "482917" } },
    ]);
  });

  it("rejects a code that is not six digits without calling the daemon", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    await expect(pairWithCode("192.168.1.20", "7878", "4829", fetchImpl)).rejects.toThrow(/6 digits/);
  });

  it("surfaces the daemon's own refusal", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "that code doesn't match" }, 401)) as unknown as typeof fetch;
    await expect(pairWithCode("192.168.1.20", "7878", "000000", fetchImpl)).rejects.toThrow(
      /doesn't match/,
    );
  });

  it("says the daemon is unreachable rather than leaking a fetch error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(pairWithCode("192.168.1.20", "7878", "482917", fetchImpl)).rejects.toThrow(
      /cannot reach lc serve/,
    );
  });

  it("refuses a 200 that carries no token", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(pairWithCode("192.168.1.20", "7878", "482917", fetchImpl)).rejects.toThrow(
      /no token/,
    );
  });
});
