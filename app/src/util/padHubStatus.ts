import { useSyncExternalStore } from "react";
import { loadPadHub, PAD_HUB_EVENT, PAD_HUB_KEY, type PadHub } from "./padHub";

export type PadHubStatus = "online" | "offline" | "unknown";
export interface PadHubStatusSnapshot {
  hub: PadHub | null;
  status: PadHubStatus;
}
export interface PadHubStatusRequest {
  generation: number;
  observation: number;
}
export type PadHubProbe = (hub: PadHub, signal: AbortSignal) => Promise<boolean>;
export const PAD_HUB_PROBE_TIMEOUT_MS = 3_000;
export const PAD_HUB_PROBE_INTERVAL_MS = 30_000;

function sameHub(left: PadHub | null, right: PadHub | null): boolean {
  return left?.url === right?.url && left?.token === right?.token;
}

/** One status for the currently configured hub; observations never cross hubs. */
export class PadHubStatusStore {
  private snapshot: PadHubStatusSnapshot;
  private listeners = new Set<() => void>();
  private generation = 0;
  private observation = 0;
  private appliedObservation = 0;
  private probing: { generation: number; promise: Promise<void>; abort: AbortController; cancel: () => void } | null = null;

  constructor(hub: PadHub | null = null) {
    this.snapshot = { hub, status: "unknown" };
  }

  getSnapshot = (): PadHubStatusSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  configure(hub: PadHub | null): boolean {
    if (sameHub(this.snapshot.hub, hub)) return false;
    this.generation += 1;
    this.cancelProbe();
    this.appliedObservation = 0;
    this.snapshot = { hub, status: "unknown" };
    this.emit();
    return true;
  }

  begin(hub: PadHub): PadHubStatusRequest | null {
    if (!sameHub(this.snapshot.hub, hub)) return null;
    return { generation: this.generation, observation: ++this.observation };
  }

  report(request: PadHubStatusRequest | null, status: "online" | "offline"): void {
    if (!request || request.generation !== this.generation || !this.snapshot.hub) return;
    // A delayed probe or request must not replace a newer observation.
    if (request.observation < this.appliedObservation) return;
    this.appliedObservation = request.observation;
    if (this.snapshot.status === status) return;
    this.snapshot = { ...this.snapshot, status };
    this.emit();
  }

  probe(probe: PadHubProbe): Promise<void> {
    const hub = this.snapshot.hub;
    if (!hub) return Promise.resolve();
    if (this.probing?.generation === this.generation) return this.probing.promise;
    const request = this.begin(hub);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let settleTimeout!: (reachable: boolean) => void;
    // Race as well as abort: a suspended WebView or a transport that ignores
    // AbortSignal must still release the status monitor after three seconds.
    const timedOut = new Promise<boolean>((resolve) => {
      settleTimeout = resolve;
      timer = setTimeout(() => {
        abort.abort();
        resolve(false);
      }, PAD_HUB_PROBE_TIMEOUT_MS);
    });
    const promise = Promise.race([
      Promise.resolve().then(() => abort.signal.aborted ? false : probe(hub, abort.signal)), timedOut,
    ]).then(
      (reachable) => {
        if (this.probing?.promise === promise) this.report(request, reachable ? "online" : "offline");
      },
      () => {
        if (this.probing?.promise === promise) this.report(request, "offline");
      },
    ).finally(() => {
      clearTimeout(timer);
      if (this.probing?.promise === promise) this.probing = null;
    });
    this.probing = {
      generation: this.generation, promise, abort,
      cancel: () => { clearTimeout(timer); settleTimeout(false); },
    };
    return promise;
  }

  cancelProbe(): void {
    if (this.probing) {
      const probing = this.probing;
      this.probing = null;
      probing.abort.abort();
      probing.cancel();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const store = new PadHubStatusStore(loadPadHub());
export const getPadHubStatus = store.getSnapshot;
export const subscribePadHubStatus = store.subscribe;

export function refreshPadHubStatus(): PadHubStatusSnapshot {
  store.configure(loadPadHub());
  return store.getSnapshot();
}

/** Also works before the app's monitor effect has mounted. No network work. */
export function isPadHubOffline(hub?: PadHub): boolean {
  const snapshot = refreshPadHubStatus();
  return !!snapshot.hub && (!hub || sameHub(snapshot.hub, hub)) && snapshot.status === "offline";
}

export function beginPadHubStatusRequest(hub: PadHub): PadHubStatusRequest | null {
  refreshPadHubStatus();
  return store.begin(hub);
}

export const reportPadHubStatus = (request: PadHubStatusRequest | null, status: "online" | "offline"): void => {
  // Settings can change while a request is in flight, before React effects run.
  refreshPadHubStatus();
  store.report(request, status);
};

export function usePadHubStatus(): PadHubStatusSnapshot {
  return useSyncExternalStore(subscribePadHubStatus, getPadHubStatus, getPadHubStatus);
}

let monitorUsers = 0;
let stopMonitor: (() => void) | null = null;

/** Mount once at the app shell. Several consumers still share one monitor. */
export function startPadHubStatusMonitoring(probe: PadHubProbe): () => void {
  monitorUsers += 1;
  if (!stopMonitor && typeof window !== "undefined") {
    let interval: ReturnType<typeof setInterval> | null = null;
    let monitoredHub: PadHub | null = null;
    let initialized = false;
    const runProbe = () => {
      refreshPadHubStatus();
      void store.probe(probe);
    };
    const configure = () => {
      const hub = refreshPadHubStatus().hub;
      // Pad-sync updates also dispatch PAD_HUB_EVENT. They must not start
      // extra probes or postpone the periodic check by restarting its timer.
      if (initialized && sameHub(monitoredHub, hub)) return;
      initialized = true;
      monitoredHub = hub;
      if (interval) clearInterval(interval);
      interval = null;
      if (hub) {
        runProbe();
        interval = setInterval(runProbe, PAD_HUB_PROBE_INTERVAL_MS);
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") runProbe();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === PAD_HUB_KEY || event.key === null) configure();
    };
    window.addEventListener(PAD_HUB_EVENT, configure);
    window.addEventListener("storage", storage);
    window.addEventListener("focus", runProbe);
    document.addEventListener("visibilitychange", visible);
    configure();
    stopMonitor = () => {
      if (interval) clearInterval(interval);
      store.cancelProbe();
      window.removeEventListener(PAD_HUB_EVENT, configure);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", runProbe);
      document.removeEventListener("visibilitychange", visible);
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    monitorUsers -= 1;
    if (monitorUsers === 0) {
      stopMonitor?.();
      stopMonitor = null;
    }
  };
}
