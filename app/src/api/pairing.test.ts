import { describe, expect, it } from "vitest";

import {
  clearPairing,
  coachSocketUrl,
  DEFAULT_PAIRING,
  loadPairing,
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
  it("reads a legacy LAN URL with token", () => {
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
  it("ignores stored LAN pairing — the GUI daemon is always loopback", () => {
    const storage = memoryStorage();
    savePairing({ baseUrl: "http://host:7878", token: "tok" }, storage);
    expect(loadPairing(storage)).toEqual(DEFAULT_PAIRING);
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
