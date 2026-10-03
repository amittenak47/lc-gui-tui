/**
 * Random palettes from ColorHunt (unofficial feed) with offline fallback.
 *
 * No need to scrape the whole site — each request asks for a random page of
 * codes. Tauri uses Rust `reqwest` (WebView CORS cannot hit colorhunt.co);
 * browser builds try `fetch` then fall back to the bundled list.
 */

import {
  COLORHUNT_FALLBACK_CODES,
  paletteFromColorHuntCode,
  pickFallbackPalette,
  type InkPalette,
  type InkPaletteHistory,
} from "./inkPaletteHistory";
import { loadPalettePrefs, normalizePalettePrefs, paletteTagQuery, type PalettePrefs, type PaletteTag } from "./palettePref";
import { mixInkPalette } from "./paletteMix";

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
  if (!Array.isArray(rows)) return [];
  const out: InkPalette[] = [];
  for (const row of rows) {
    if (typeof row?.code !== "string") continue;
    const palette = paletteFromColorHuntCode(row.code);
    if (palette) out.push(palette);
  }
  return out;
}

/** Bright, saturated ink as opposed to a dark hue or a near-white pastel. */
export function hasVividInk(palette: InkPalette): boolean {
  return palette.some(hex => {
    const rgb = hex.slice(1).match(/.{2}/g)?.map(channel => parseInt(channel, 16) / 255);
    if (!rgb || rgb.length !== 3) return false;
    const max = Math.max(...rgb), min = Math.min(...rgb);
    return max >= 0.72 && max - min >= 0.5;
  });
}

export function chooseFeedPalette(history: InkPaletteHistory, palettes: InkPalette[], balance: boolean, random = Math.random): InkPalette | null {
  if (palettes.length === 0) return null;
  const seen = new Set(history.items.map(p => p.join(",").toLowerCase()));
  const fresh = palettes.filter(p => !seen.has(p.join(",").toLowerCase()));
  let choices = fresh.length ? fresh : palettes;
  // "Any" should include vivid ink, too. Break runs of muted palettes without
  // changing feed colors or overriding an explicitly chosen pastel/dark tag.
  if (balance && !hasVividInk(history.items[history.index] ?? [])) {
    const vivid = choices.filter(hasVividInk);
    if (vivid.length) choices = vivid;
  }
  return choices[Math.floor(random() * choices.length)]!;
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
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return [];
    const text = await response.text();
    return palettesFromFeed(text);
  } catch {
    return [];
  }
}

const FEED_CACHE_MS = 3 * 60_000;
const EMPTY_CACHE_MS = 10_000;
const FEED_CONCURRENCY = 4;
const keyOf = (palette: InkPalette) => palette.join(",").toLowerCase();

/** The same feed code can occur under several selected tags. */
export function poolFeedPalettes(feeds: readonly InkPalette[][]): InkPalette[] {
  const seen = new Set<string>();
  return feeds.flat().filter(palette => {
    const key = keyOf(palette);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cache and rotation are shared by wheels, while their histories stay per board. */
export function createColorHuntSource(
  fetchFeed: (query: string) => Promise<InkPalette[]>,
  options: { now?: () => number; random?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => Math.random());
  const cache = new Map<string, { expires: number; value: Promise<InkPalette[]> }>();
  const cursors = new Map<string, number>();
  const request = (query: string, refresh = false): Promise<InkPalette[]> => {
    const hit = cache.get(query);
    if (!refresh && hit && hit.expires > now()) return hit.value;
    const entry = { expires: Infinity, value: Promise.resolve([] as InkPalette[]) };
    entry.value = Promise.resolve().then(() => fetchFeed(query)).catch(() => [])
      .then(palettes => {
        entry.expires = now() + (palettes.length ? FEED_CACHE_MS : EMPTY_CACHE_MS);
        return poolFeedPalettes([palettes]);
      });
    cache.set(query, entry);
    return entry.value;
  };
  const fetchPools = async (queries: string[], refresh = false) => {
    const feeds: InkPalette[][] = new Array(queries.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(FEED_CONCURRENCY, queries.length) }, async () => {
      while (next < queries.length) {
        const i = next++;
        feeds[i] = await request(queries[i]!, refresh);
      }
    }));
    return feeds;
  };
  return {
    async next(history: InkPaletteHistory, input: PalettePrefs | PaletteTag, paper = "#ffffff"): Promise<InkPalette> {
      const prefs = normalizePalettePrefs(input);
      const queries = prefs.tags.map(paletteTagQuery);
      const seen = new Set(history.items.map(keyOf));
      const fresh = (palettes: InkPalette[]) => palettes.filter(p => !seen.has(keyOf(p)));
      const balance = prefs.tags.includes("any");
      let feeds: InkPalette[][] = [];
      let live: InkPalette[] = [];
      if (prefs.matchAll && queries.length > 1) {
        const query = queries.join("-");
        live = await request(query);
        if (live.length && !fresh(live).length) live = await request(query, true);
      }
      // Hyphens are AND. An empty intersection falls back to the OR pool.
      if (!live.length) {
        feeds = await fetchPools(queries);
        live = poolFeedPalettes(feeds);
        if (live.length && !fresh(live).length) {
          feeds = await fetchPools(queries, true);
          live = poolFeedPalettes(feeds);
        }
      }
      if (prefs.mixColours) {
        const seed = Math.floor(random() * 4294967296);
        const mixOptions = { seen, preferVivid: balance && !hasVividInk(history.items[history.index] ?? []) };
        const mixed = mixInkPalette(live, paper, seed, mixOptions);
        if (mixed) return mixed;
        const fallback = COLORHUNT_FALLBACK_CODES.map(paletteFromColorHuntCode).filter((p): p is InkPalette => p !== null);
        const offlineMix = mixInkPalette(fallback, paper, seed, mixOptions);
        if (offlineMix) return offlineMix;
        throw new Error("No distinct, readable ink colours for this paper");
      }
      if (feeds.length) {
        const key = queries.join("|");
        const start = cursors.get(key) ?? 0;
        for (let n = 0; n < feeds.length; n++) {
          const i = (start + n) % feeds.length;
          const selected = chooseFeedPalette(history, fresh(feeds[i]!), balance, random);
          if (!selected) continue;
          cursors.set(key, (i + 1) % feeds.length);
          return selected;
        }
      } else {
        const selected = chooseFeedPalette(history, fresh(live), balance, random);
        if (selected) return selected;
      }
      return pickFallbackPalette(history);
    },
  };
}

const source = createColorHuntSource(query => isTauriRuntime() ? fetchViaTauri(query) : fetchViaBrowser(query));

/** Live palettes when available; the bundled list remains usable offline. */
export async function fetchNextColorHuntPalette(
  history: InkPaletteHistory,
  prefs: PalettePrefs | PaletteTag = loadPalettePrefs(),
  paper = "#ffffff",
): Promise<InkPalette> {
  return source.next(history, prefs, paper);
}
