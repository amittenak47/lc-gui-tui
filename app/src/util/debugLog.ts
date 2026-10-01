/**
 * A debug log of what the app does, for finding out why it did it.
 *
 * Off by default, and off means off: nothing is wrapped, observed or stored,
 * so the app runs exactly as it does without this file. Turned on (Settings →
 * Diagnostics, or `localStorage["lc-debug-log"] = "1"`), it records
 *
 *  - what the reader does: taps and clicks by label, keys by name (never what
 *    was typed), tab visibility;
 *  - every native call (`invoke`) and network request (`fetch`): what was
 *    asked, how long it took, what came back or what failed;
 *  - calls on the board and the app's client, through {@link wrapForDebug};
 *  - the app's own console lines (`[lc:open]`, `[lc:gc]` …), warnings,
 *    errors, uncaught errors and rejections;
 *  - main-thread stalls of 50 ms or more.
 *
 * Arguments and results are truncated. Entries go to their own small
 * database, newest {@link MAX_ENTRIES} kept, and leave as a `.jsonl` file
 * from Settings.
 */

const ENABLED_KEY = "lc-debug-log";
const DB_NAME = "whiteboard.debugLog";
const STORE = "entries";
/** Entries kept on the device; older ones are dropped as new ones land. */
export const MAX_ENTRIES = 50_000;
const FLUSH_MS = 2000;
const TEXT_LIMIT = 300;
/** A method called more often than this per second is summarised, not listed. */
const PER_SECOND_LIMIT = 20;

export interface DebugEntry {
  /** Epoch ms. */
  t: number;
  /** What sort of thing happened: action, invoke, fetch, call, console, error, stall. */
  k: string;
  /** Which one: a label, a command, a URL, a method. */
  n: string;
  /** Arguments, truncated. */
  a?: string;
  /** Result, truncated. */
  r?: string;
  /** How long it took. */
  ms?: number;
  /** What went wrong. */
  e?: string;
}

let installed: (() => void) | null = null;
let buffer: DebugEntry[] = [];
let flushTimer = 0;

/** The log is recording now. */
export function debugLogActive(): boolean {
  return installed !== null;
}

export function debugLogEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebugLogEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* no storage: the switch lasts this session only */
  }
  if (on) installDebugLog();
  else uninstallDebugLog();
}

/** Short, safe text for any value: never throws, never long. */
export function brief(value: unknown, limit = TEXT_LIMIT): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…(${value.length})` : value;
  if (typeof value === "function") return "[function]";
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength}]`;
  if (typeof Blob !== "undefined" && value instanceof Blob) return `[Blob ${value.type} ${value.size}]`;
  if (typeof Element !== "undefined" && value instanceof Element) return `[${value.tagName.toLowerCase()}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "string" && v.length > 80) return `${v.slice(0, 80)}…(${v.length})`;
      if (Array.isArray(v) && v.length > 12) return [...v.slice(0, 12), `…+${v.length - 12}`];
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      if (typeof v === "function") return "[function]";
      return v;
    });
    if (text === undefined) return String(value);
    return text.length > limit ? `${text.slice(0, limit)}…(${text.length})` : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Entries not yet written: for tests. */
export function pendingDebugEntriesForTests(): readonly DebugEntry[] {
  return buffer;
}

/** Record one entry, when the log is on. */
export function debugLog(entry: Omit<DebugEntry, "t">): void {
  if (!installed) return;
  buffer.push({ t: Date.now(), ...entry });
  if (!flushTimer) flushTimer = window.setTimeout(() => void flush(), FLUSH_MS);
}

/* ------------------------------------------------------------ storage */

let dbPromise: Promise<IDBDatabase> | null = null;
function openLogDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open the debug log"));
  }).catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  return dbPromise;
}

async function flush(): Promise<void> {
  flushTimer = 0;
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const db = await openLogDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const entry of batch) store.add(entry);
      const count = store.count();
      count.onsuccess = () => {
        const extra = count.result - MAX_ENTRIES;
        if (extra <= 0) return;
        // Keys rise with time: the oldest go first.
        const keys = store.getAllKeys(null, extra);
        keys.onsuccess = () => {
          const list = keys.result as number[];
          if (list.length > 0) store.delete(IDBKeyRange.bound(list[0]!, list[list.length - 1]!));
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* a log that cannot be written is not worth breaking the app over */
  }
}

async function readAll(): Promise<DebugEntry[]> {
  await flush();
  const db = await openLogDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as DebugEntry[]);
    request.onerror = () => reject(request.error ?? new Error("could not read the debug log"));
  });
}

export async function debugLogCount(): Promise<number> {
  try {
    await flush();
    const db = await openLogDb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

export async function clearDebugLog(): Promise<void> {
  buffer = [];
  const db = await openLogDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** The whole log as JSON lines, one entry each, oldest first. */
export async function debugLogText(): Promise<string> {
  return (await readAll()).map((entry) => JSON.stringify(entry)).join("\n");
}

/** Hand the log to the reader as a `.jsonl` file. */
export async function exportDebugLog(): Promise<void> {
  const text = await debugLogText();
  const blob = new Blob([text], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `lc-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------ hooks */

/** What a tap or click was on, in words. */
function labelOf(target: EventTarget | null): string {
  const el = target instanceof Element ? target.closest("button, a, [role], input, textarea, select, label") ?? target : null;
  if (!el) return "?";
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.slice(0, 80);
  const text = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ");
  if (text) return text.slice(0, 60);
  const cls = typeof el.className === "string" ? el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** Keys by name only: a letter is "char", so nothing typed is ever kept. */
function keyName(event: KeyboardEvent): string {
  const mods = [event.ctrlKey && "Ctrl", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  const key = event.key.length === 1 ? "char" : event.key;
  return [...mods, key].join("+");
}

export function installDebugLog(): void {
  if (installed || typeof window === "undefined") return;
  const undo: Array<() => void> = [];
  const skipped: string[] = [];
  const guard = (name: string, attach: () => void) => {
    try {
      attach();
    } catch {
      skipped.push(name);
    }
  };

  const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void) => {
    window.addEventListener(type, handler, true);
    undo.push(() => window.removeEventListener(type, handler, true));
  };
  listen("click", (event) => debugLog({ k: "action", n: `click ${labelOf(event.target)}` }));
  listen("pointerdown", (event) => debugLog({ k: "action", n: `${event.pointerType} down ${labelOf(event.target)}` }));
  listen("keydown", (event) => debugLog({ k: "action", n: `key ${keyName(event)}` }));
  const onVisibility = () => debugLog({ k: "action", n: `visibility ${document.visibilityState}` });
  document.addEventListener("visibilitychange", onVisibility);
  undo.push(() => document.removeEventListener("visibilitychange", onVisibility));
  listen("error", (event) => debugLog({ k: "error", n: "uncaught", e: brief(event.error ?? event.message) }));
  listen("unhandledrejection", (event) => debugLog({ k: "error", n: "unhandled rejection", e: brief(event.reason) }));

  // Native calls are recorded by the `invoke` in tauriCore.ts: Tauri's own is read-only.

  // Network requests. Each hook on its own: one that cannot attach is skipped,
  // never allowed to stop the app starting.
  guard("fetch", () => {
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const started = performance.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    return originalFetch.call(window, input, init).then(
      (response) => {
        debugLog({ k: "fetch", n: `${method} ${brief(url, 160)}`, r: `${response.status}`, ms: Math.round(performance.now() - started) });
        return response;
      },
      (cause: unknown) => {
        debugLog({ k: "fetch", n: `${method} ${brief(url, 160)}`, e: brief(cause), ms: Math.round(performance.now() - started) });
        throw cause;
      },
    );
  };
  undo.push(() => {
    window.fetch = originalFetch;
  });
  });

  // The app's own console lines, warnings and errors.
  guard("console", () => {
  for (const level of ["info", "warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      debugLog({ k: "console", n: level, a: args.map((arg) => brief(arg, 200)).join(" ").slice(0, TEXT_LIMIT * 2) });
      original.apply(console, args);
    };
    undo.push(() => {
      console[level] = original;
    });
  }
  });

  // Main-thread stalls.
  guard("stalls", () => {
  if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) debugLog({ k: "stall", n: "long task", ms: Math.round(entry.duration) });
    });
    observer.observe({ type: "longtask", buffered: false });
    undo.push(() => observer.disconnect());
  }
  });

  installed = () => {
    for (const step of undo.reverse()) step();
  };
  debugLog({ k: "action", n: "debug log on", ...(skipped.length > 0 ? { e: `not recorded: ${skipped.join(", ")}` } : {}) });
}

export function uninstallDebugLog(): void {
  if (!installed) return;
  debugLog({ k: "action", n: "debug log off" });
  void flush();
  installed();
  installed = null;
}

/* ------------------------------------------------------------ objects */

/** Methods called every frame: counted, not listed. */
const HOT = new Set([
  "getViewportBounds", "sceneToClient", "isInking", "getInkRevision", "getInkOpCount",
  "readingPageFrames", "readingPageBox", "dirtyInkPageCount", "getElements", "getStrokes", "getInkStrokes",
]);

/**
 * Log every method called on `target` — arguments, result, time — when the log
 * is on. Off, the object is handed back untouched, so wrapping costs nothing.
 * Hot accessors are summarised once a second instead of listed.
 */
export function wrapForDebug<T extends object>(label: string, target: T): T {
  // Installed at startup when switched on (main.tsx), before anything is wrapped.
  if (!installed) return target;
  const counts = new Map<string, number>();
  let window0 = Date.now();
  const allow = (name: string) => {
    const now = Date.now();
    if (now - window0 >= 1000) {
      for (const [method, count] of counts) {
        if (count > PER_SECOND_LIMIT || HOT.has(method)) debugLog({ k: "call", n: `${label}.${method}`, a: `${count} calls in the last second` });
      }
      counts.clear();
      window0 = now;
    }
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return !HOT.has(name) && count <= PER_SECOND_LIMIT;
  };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return function (this: unknown, ...args: unknown[]) {
        const listed = allow(prop);
        const started = performance.now();
        try {
          const result = value.apply(this === receiver ? obj : this, args);
          if (!listed) return result;
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then(
              (settled) => {
                debugLog({ k: "call", n: `${label}.${prop}`, a: brief(args), r: brief(settled), ms: Math.round(performance.now() - started) });
                return settled;
              },
              (cause: unknown) => {
                debugLog({ k: "call", n: `${label}.${prop}`, a: brief(args), e: brief(cause), ms: Math.round(performance.now() - started) });
                throw cause;
              },
            );
          }
          debugLog({ k: "call", n: `${label}.${prop}`, a: brief(args), r: brief(result), ms: Math.round(performance.now() - started) });
          return result;
        } catch (cause) {
          if (listed) debugLog({ k: "call", n: `${label}.${prop}`, a: brief(args), e: brief(cause) });
          throw cause;
        }
      };
    },
  });
}
