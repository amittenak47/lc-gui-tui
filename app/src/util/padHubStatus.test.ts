/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAD_HUB_EVENT, savePadHub, setHostLoopback } from "./padHub";
import {
  getPadHubStatus, PAD_HUB_PROBE_INTERVAL_MS, PAD_HUB_PROBE_TIMEOUT_MS,
  PadHubStatusStore, refreshPadHubStatus, startPadHubStatusMonitoring,
} from "./padHubStatus";

const HUB = { url: "http://hub.test", token: "123456" };
const cleanup: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  setHostLoopback(null);
  refreshPadHubStatus();
});

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  savePadHub(null);
  refreshPadHubStatus();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PadHubStatusStore", () => {
  it("starts unknown and emits only real transitions", () => {
    const store = new PadHubStatusStore(HUB);
    const changed = vi.fn();
    store.subscribe(changed);
    expect(store.getSnapshot().status).toBe("unknown");
    store.report(store.begin(HUB), "online");
    store.report(store.begin(HUB), "online");
    store.report(store.begin(HUB), "offline");
    expect(store.getSnapshot()).toEqual({ hub: HUB, status: "offline" });
    expect(changed).toHaveBeenCalledTimes(2);
    store.configure(null);
    expect(store.getSnapshot()).toEqual({ hub: null, status: "unknown" });
  });

  it("rejects responses from an earlier configured hub, even after switching back", () => {
    const store = new PadHubStatusStore(HUB);
    const old = store.begin(HUB);
    store.configure({ ...HUB, token: "654321" });
    store.configure(HUB);
    store.report(old, "offline");
    expect(store.getSnapshot().status).toBe("unknown");
    store.report(store.begin(HUB), "online");
    expect(store.getSnapshot().status).toBe("online");
  });

  it("does not let an old slow probe override a newer successful request", async () => {
    const store = new PadHubStatusStore(HUB);
    let resolve!: (online: boolean) => void;
    const pending = store.probe(() => new Promise<boolean>((done) => { resolve = done; }));
    await Promise.resolve();
    store.report(store.begin(HUB), "online");
    resolve(false);
    await pending;
    expect(store.getSnapshot().status).toBe("online");
  });

  it("bounds the probe at three seconds even when the transport ignores abort", async () => {
    vi.useFakeTimers();
    const store = new PadHubStatusStore(HUB);
    let signal!: AbortSignal;
    const pending = store.probe((_hub, nextSignal) => {
      signal = nextSignal;
      return new Promise<boolean>(() => {});
    });
    await vi.advanceTimersByTimeAsync(PAD_HUB_PROBE_TIMEOUT_MS - 1);
    expect(store.getSnapshot().status).toBe("unknown");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(store.getSnapshot().status).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not probe or allocate a timer without a hub", async () => {
    vi.useFakeTimers();
    const store = new PadHubStatusStore();
    const probe = vi.fn();
    await store.probe(probe);
    expect(probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares an in-flight probe and permits the next probe after failure", async () => {
    const store = new PadHubStatusStore(HUB);
    const probe = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(true);
    const pending = store.probe(probe);
    expect(store.probe(probe)).toBe(pending);
    await pending;
    expect(store.getSnapshot().status).toBe("offline");
    await store.probe(probe);
    expect(store.getSnapshot().status).toBe("online");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending probe and its timeout when the hub is removed", async () => {
    vi.useFakeTimers();
    const store = new PadHubStatusStore(HUB);
    const pending = store.probe(() => new Promise<boolean>(() => {}));
    await Promise.resolve();
    store.configure(null);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getSnapshot()).toEqual({ hub: null, status: "unknown" });
  });
});

describe("hub monitor lifecycle", () => {
  it("does no probing on startup, focus, resume, or timer ticks without a hub", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(true);
    cleanup.push(startPadHubStatusMonitoring(probe));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(PAD_HUB_PROBE_INTERVAL_MS * 3);
    expect(probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getPadHubStatus()).toEqual({ hub: null, status: "unknown" });
  });

  it("probes on startup, focus, visible resume and every 30 seconds, stopping when disconnected", async () => {
    vi.useFakeTimers();
    savePadHub(HUB);
    const probe = vi.fn().mockResolvedValue(true);
    cleanup.push(startPadHubStatusMonitoring(probe));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPadHubStatus().status).toBe("online");
    expect(probe).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(PAD_HUB_PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(4);
    savePadHub(null);
    await vi.advanceTimersByTimeAsync(PAD_HUB_PROBE_INTERVAL_MS * 2);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores pad-sync events for the same hub without restarting the cadence", async () => {
    vi.useFakeTimers();
    savePadHub(HUB);
    const probe = vi.fn().mockResolvedValue(true);
    cleanup.push(startPadHubStatusMonitoring(probe));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(PAD_HUB_EVENT, { detail: "sync" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
