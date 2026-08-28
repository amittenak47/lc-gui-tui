/**
 * In-process harness calls. Named Tauri commands — no URL, no dummy host.
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let invokeLoader: Promise<Invoke | null> | null = null;

export function loadInvoke(): Promise<Invoke | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as Invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

export interface LcInvokeResponse {
  status: number;
  body: unknown;
}

/**
 * Router commands return `{ status, body }`. A few named commands (DLC) used
 * to return the payload itself. Arrays have no `.body`, so treating them as
 * the envelope yields `undefined` and Settings → Workspace whitescreens.
 */
export function isLcInvokeResponse(result: unknown): result is LcInvokeResponse {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return typeof (result as { status?: unknown }).status === "number";
}

export function readInvokeResult<T>(result: unknown): { status: number; body: T } {
  if (isLcInvokeResponse(result)) {
    return { status: result.status, body: result.body as T };
  }
  return { status: 200, body: result as T };
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
