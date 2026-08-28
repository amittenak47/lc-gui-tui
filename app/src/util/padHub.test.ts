/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PAD_HUB_EVENT,
  PAD_HUB_KEY,
  loadPadHub,
  loadSavedPadHub,
  normalizeHubUrl,
  savePadHub,
  setHostLoopback,
} from "./padHub";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  setHostLoopback(null);
  vi.unstubAllGlobals();
});

describe("normalizeHubUrl", () => {
  it("gives a bare host:port a scheme", () => {
    // Settings shows the PC's address as `host:port`, so this is what people
    // type. `fetch` reads a schemeless string as a *relative* URL, which
    // resolves against the tablet's own origin — the walk then asks the tablet
    // about itself and can sit on Pad having never reached the PC.
    expect(normalizeHubUrl("192.168.1.10:7878")).toBe("http://192.168.1.10:7878");
  });

  it("leaves a real scheme alone", () => {
    expect(normalizeHubUrl("http://192.168.1.10:7878")).toBe("http://192.168.1.10:7878");
    expect(normalizeHubUrl("https://pads.example")).toBe("https://pads.example");
  });

  it("trims whitespace and a trailing slash", () => {
    expect(normalizeHubUrl("  192.168.1.10:7878/  ")).toBe("http://192.168.1.10:7878");
  });

  it("says nothing about an empty address", () => {
    expect(normalizeHubUrl("   ")).toBe("");
  });
});

describe("saved hubs", () => {
  it("normalises what it stores, so a walk reaches the PC", () => {
    savePadHub({ url: "192.168.1.10:7878", token: "660105" });
    expect(loadSavedPadHub()).toEqual({
      url: "http://192.168.1.10:7878",
      token: "660105",
    });
  });

  it("reads a schemeless address stored by an older build", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        [PAD_HUB_KEY]: JSON.stringify({ url: "192.168.1.10:7878", token: "660105" }),
      }),
    );
    expect(loadSavedPadHub()?.url).toBe("http://192.168.1.10:7878");
  });

  it("refuses a half-filled pair", () => {
    savePadHub({ url: "192.168.1.10:7878", token: "  " });
    expect(loadSavedPadHub()).toBeNull();
  });
});

describe("the host's own loopback", () => {
  it("is a hub for everything gated on one", () => {
    // The desktop that *is* the hub leaves Connect empty on purpose, so it had
    // no hub at all: no Sync pill, and nowhere for `indexFromBytes` to go.
    expect(loadPadHub()).toBeNull();
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    expect(loadPadHub()).toEqual({ url: "http://127.0.0.1:7878", token: "t" });
  });

  it("stays out of the Connect form", () => {
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    // Filling the fields in would read as "connected to some other PC".
    expect(loadSavedPadHub()).toBeNull();
  });

  it("never reaches storage", () => {
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    expect(localStorage.getItem(PAD_HUB_KEY)).toBeNull();
  });

  it("loses to a hub someone actually paired with", () => {
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    savePadHub({ url: "192.168.1.10:7878", token: "660105" });
    expect(loadPadHub()?.url).toBe("http://192.168.1.10:7878");
  });

  it("announces itself, so the pill can mount without a remount", () => {
    const seen = vi.fn();
    window.addEventListener(PAD_HUB_EVENT, seen);
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    expect(seen).toHaveBeenCalledTimes(1);
    // Setting the same one again is not news.
    setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });
    expect(seen).toHaveBeenCalledTimes(1);
    setHostLoopback(null);
    expect(seen).toHaveBeenCalledTimes(2);
    window.removeEventListener(PAD_HUB_EVENT, seen);
  });
});
