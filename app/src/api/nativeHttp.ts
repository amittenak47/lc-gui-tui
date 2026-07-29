/**
 * HTTP to `lc serve` — `fetch` on desktop/browser, Rust `reqwest` on Tauri.
 *
 * Android WebView blocks cleartext HTTP to LAN IPs even when Chrome on the same
 * tablet can open `/health`. Proxying through {@link lc_request} sidesteps that.
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function isTauriRuntime(): boolean {
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

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function bodyJson(init?: RequestInit): unknown {
  if (init?.body === undefined || init?.body === null) return undefined;
  if (typeof init.body === "string") {
    if (init.body.length === 0) return undefined;
    return JSON.parse(init.body) as unknown;
  }
  throw new Error("lcFetch only supports string JSON bodies");
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
        const headers = headersOf(init);
        const result = await invoke<LcProxyResponse>("lc_request", {
          request: {
            base_url: `${parsed.protocol}//${parsed.host}`,
            path: `${parsed.pathname}${parsed.search}`,
            method: init?.method ?? "GET",
            token: headers.get("X-LC-Token") ?? undefined,
            body: bodyJson(init),
          },
        });

        return new Response(bodyText(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        // Tauri shell without lc_request — fall back to WebView fetch.
      }
    }
  }

  return globalThis.fetch(input, init);
}
