/**
 * HTTP to the embedded harness router — `fetch` in the browser, in-process
 * dispatch on Tauri (no loopback TCP).
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let invokeLoader: Promise<Invoke | null> | null = null;

function loadInvoke(): Promise<Invoke | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as Invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

interface LcProxyResponse {
  status: number;
  body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyJson(init?: RequestInit): unknown {
  if (init?.body === undefined || init?.body === null) return undefined;
  if (typeof init.body === "string") {
    if (init.body.length === 0) return undefined;
    return JSON.parse(init.body) as unknown;
  }
  return undefined;
}

function rawBase64(init?: RequestInit): string | undefined {
  const body = init?.body;
  if (body instanceof ArrayBuffer) return bytesToB64(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return bytesToB64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return undefined;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bodyText(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/** Drop-in `fetch` that routes through Tauri when available. */
export async function lcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    const invoke = await loadInvoke();
    if (invoke) {
      try {
        const parsed = new URL(urlOf(input));
        const result = await invoke<LcProxyResponse>("lc_dispatch", {
          request: {
            path: `${parsed.pathname}${parsed.search}`,
            method: init?.method ?? "GET",
            body: bodyJson(init),
            raw_base64: rawBase64(init),
          },
        });

        const packed = result.body as { $bytes?: string } | null;
        if (packed && typeof packed === "object" && typeof packed.$bytes === "string") {
          return new Response(new Blob([new Uint8Array(b64ToBytes(packed.$bytes))]), {
            status: result.status,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }

        return new Response(bodyText(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        if (err instanceof Error) throw err;
        throw new Error(String(err));
      }
    }
  }

  return globalThis.fetch(input, init);
}
