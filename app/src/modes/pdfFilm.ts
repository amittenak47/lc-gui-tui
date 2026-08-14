/**
 * Bottom PDF filmstrip — which thumbs to keep, and a cheap copy from a page
 * already painted in the scene.
 *
 * The strip is chrome, not scene: it must not ask pdf.js for every page in a
 * textbook. Nearby pages copy their live canvas; the rest wait until they
 * scroll into the strip.
 */

export type PdfThumbRenderer = (page: number) => Promise<string | null>;

export const PDF_FILM_PREF_KEY = "whiteboard.pdfFilm";
/** Replaces the old always-on number column — on until the reader hides it. */
export const PDF_FILM_DEFAULT = true;
export const PDF_FILM_THUMB_CSS = 48;
export const PDF_FILM_CACHE = 40;
export const PDF_FILM_RADIUS = 10;
export const PDF_LETTER_ASPECT = 612 / 792;

export function loadPdfFilmPref(): boolean {
  try {
    const raw = localStorage.getItem(PDF_FILM_PREF_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* private mode */
  }
  return PDF_FILM_DEFAULT;
}

export function savePdfFilmPref(on: boolean): void {
  try {
    localStorage.setItem(PDF_FILM_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/**
 * Pages whose thumbnails should be filled.
 *
 * `current` plus a radius, unioned with whatever cells are on the strip's
 * own viewport. Caps at the document; empty current falls back to page 1.
 */
export function thumbWindow(
  current: number,
  count: number,
  extra: Iterable<number> = [],
  radius = PDF_FILM_RADIUS,
): number[] {
  const last = Math.max(1, count);
  const focus = Number.isFinite(current) ? current : 1;
  const wanted = new Set<number>();
  const add = (n: number) => {
    if (n >= 1 && n <= last) wanted.add(n);
  };
  for (let d = -radius; d <= radius; d += 1) add(focus + d);
  for (const n of extra) add(n);
  if (wanted.size === 0) add(1);
  return [...wanted].sort((a, b) => a - b);
}

/** Drop cached thumbs farthest from the page in view when the map is full. */
export function trimThumbCache(
  cache: Map<number, string>,
  current: number,
  keep: Iterable<number>,
  cap = PDF_FILM_CACHE,
): Map<number, string> {
  if (cache.size <= cap) return cache;
  const pinned = new Set(keep);
  const ranked = [...cache.keys()].sort((a, b) => {
    const pa = pinned.has(a) ? 0 : 1;
    const pb = pinned.has(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return Math.abs(a - current) - Math.abs(b - current);
  });
  const next = new Map<number, string>();
  for (const n of ranked.slice(0, cap)) {
    const url = cache.get(n);
    if (url) next.set(n, url);
  }
  return next;
}

export function grabLivePdfThumb(page: number, maxWidth: number): string | null {
  const slot = document.querySelector<HTMLElement>(
    `.lc-pdf-page[data-pdf-page="${page}"][data-painted]`,
  );
  const canvas = slot?.querySelector("canvas");
  if (!canvas || canvas.width < 8 || canvas.height < 8) return null;
  const out = document.createElement("canvas");
  const w = Math.max(1, Math.round(maxWidth));
  const h = Math.max(1, Math.round(w * (canvas.height / canvas.width)));
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, w, h);
  try {
    return out.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}
