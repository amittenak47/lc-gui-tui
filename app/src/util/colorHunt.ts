/**
 * Random palettes from ColorHunt (unofficial feed) with offline fallback.
 *
 * No need to scrape the whole site — each request asks for a random page of
 * codes. Tauri uses Rust `reqwest` (WebView CORS cannot hit colorhunt.co);
 * browser builds try `fetch` then fall back to the bundled list.
 */

import {
  paletteFromColorHuntCode,
  pickFallbackPalette,
  type InkPalette,
  type InkPaletteHistory,
} from "./inkPaletteHistory";
import { loadPaletteTag, paletteTagQuery } from "./palettePref";

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

interface ColorHuntRow {
  code?: string;
}

export function palettesFromFeed(body: unknown): InkPalette[] {
  let rows: ColorHuntRow[] = [];
  if (typeof body === "string") {
    try {
      rows = JSON.parse(body) as ColorHuntRow[];
    } catch {
      return [];
    }
  } else if (Array.isArray(body)) {
    rows = body as ColorHuntRow[];
  }
  const out: InkPalette[] = [];
  for (const row of rows) {
    if (!row?.code) continue;
    const palette = paletteFromColorHuntCode(row.code);
    if (palette) out.push(palette);
  }
  return out;
}

async function fetchViaTauri(tags: string): Promise<InkPalette[]> {
  const invoke = await loadInvoke();
  if (!invoke) return [];
  try {
    const rows = await invoke<ColorHuntRow[]>("colorhunt_random", { tags });
    return palettesFromFeed(rows);
  } catch {
    return [];
  }
}

async function fetchViaBrowser(tags: string): Promise<InkPalette[]> {
  const url =
    import.meta.env.DEV && !isTauriRuntime()
      ? "/colorhunt-feed"
      : "https://colorhunt.co/php/feed.php";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
      },
      body: `step=0&sort=random&tags=${encodeURIComponent(tags)}`,
    });
    if (!response.ok) return [];
    const text = await response.text();
    return palettesFromFeed(text);
  } catch {
    return [];
  }
}

/**
 * One new palette for this board's history. Prefers a live ColorHunt hit;
 * otherwise a bundled code the board has not used yet.
 *
 * The tag is the reader's standing answer to "what kind of colours" — see
 * `palettePref`. It only reaches the live feed: the bundled fallback list is a
 * fixed set of codes with no tags of its own, and pretending to filter it would
 * mean returning nothing offline rather than returning something.
 */
export async function fetchNextColorHuntPalette(
  history: InkPaletteHistory,
  tag = loadPaletteTag(),
): Promise<InkPalette> {
  const tags = paletteTagQuery(tag);
  const live = isTauriRuntime() ? await fetchViaTauri(tags) : await fetchViaBrowser(tags);
  if (live.length > 0) {
    const seen = new Set(history.items.map((p) => p.join(",").toLowerCase()));
    const fresh = live.find((p) => !seen.has(p.join(",").toLowerCase()));
    if (fresh) return fresh;
    return live[Math.floor(Math.random() * live.length)];
  }
  return pickFallbackPalette(history);
}
