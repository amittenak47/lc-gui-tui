/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchDocHubHint } from "./hubHint";
import { PAD_HUB_KEY } from "./padHub";

/**
 * jsdom under Node ≥22 leaves `localStorage` unpopulated (Node's lazy global
 * getter wins), so every test installs its own map-backed copy — same as
 * autosavePref.test.ts does.
 */
const store = new Map<string, string>();
function stubLocalStorage(): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  });
}

function useHub(): void {
  localStorage.setItem(
    PAD_HUB_KEY,
    JSON.stringify({ url: "http://hub.test", token: "t0ken" }),
  );
}

/** One route table entry per URL; anything else 404s. */
function serve(routes: Record<string, { json?: unknown; status?: number; ok?: boolean }>) {
  const calls: Array<{ method: string | undefined; url: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method, url });
    const hit = routes[url];
    if (!hit) {
      return new Response("{}", { status: 404 });
    }
    const body = hit.json === undefined ? "{}" : JSON.stringify(hit.json);
    return new Response(body, { status: hit.status ?? (hit.ok === false ? 500 : 200) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  store.clear();
});

describe("fetchDocHubHint", () => {
  it("reports what the hub already has, read-only", async () => {
    stubLocalStorage();
    useHub();
    serve({
      // One pad, by id — not the whole library through `pads/sync`.
      "http://hub.test/pads/annotate/pad-1": {
        json: { id: "pad-1", updated_at: 500 },
      },
      "http://hub.test/docs/h%40sh/bytes": { json: {} },
      "http://hub.test/docs/h%40sh/index": { json: { indexed: true, page_count: 12 } },
    });

    const hint = await fetchDocHubHint({ hash: "h@sh", padId: "pad-1" });
    expect(hint.padUpdatedAt).toBe(500);
    expect(hint.bytesOnHub).toBe(true);
    expect(hint.indexedOnHub).toBe(true);
  });

  it("reads absence, deletion, and an empty index as not-there", async () => {
    stubLocalStorage();
    useHub();
    // The pad route serves a tombstoned row as 404, so absent and deleted are
    // the same answer here: the hub has no row for this pad.
    serve({
      // pad, bytes and index all missing → 404s
    });

    const hint = await fetchDocHubHint({ hash: "abc", padId: "pad-1" });
    expect(hint.padUpdatedAt).toBeNull();
    expect(hint.bytesOnHub).toBe(false);
    expect(hint.indexedOnHub).toBe(false);
  });

  it("does not count page-less indexes as indexed", async () => {
    stubLocalStorage();
    useHub();
    serve({
      "http://hub.test/docs/abc/index": { json: { indexed: true, page_count: 0 } },
    });
    const hint = await fetchDocHubHint({ hash: "abc" });
    expect(hint.indexedOnHub).toBe(false);
  });

  it("survives probes failing individually and sends no writes", async () => {
    stubLocalStorage();
    useHub();
    const routes: Record<string, { json?: unknown }> = {};
    serve(routes);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await expect(fetchDocHubHint({ hash: "abc", padId: "p" })).resolves.toEqual({
      hash: "abc",
      padUpdatedAt: null,
      bytesOnHub: false,
      indexedOnHub: false,
    });

    for (const call of fetchMock.mock.calls as Array<[string, RequestInit?]>) {
      expect(["GET", "HEAD"]).toContain(call[1]?.method ?? "GET");
    }
  });

  it("refuses to probe without a hub instead of guessing local", async () => {
    await expect(fetchDocHubHint({ hash: "abc" })).rejects.toThrow(/no hub/i);
  });
});
