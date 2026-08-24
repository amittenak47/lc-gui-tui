/**
 * Make the PDF text layer's boxes as wide as the glyphs they sit on.
 *
 * pdf.js sizes each text span by drawing the same string into a canvas, asking
 * the canvas how wide it came out, and stretching the span with `scaleX` until
 * the two agree. That closes the loop only while canvas text and DOM text come
 * out at the same size — and on Android they do not. The system font-size
 * setting reaches the WebView as a *text zoom*: every string laid out in the
 * DOM renders at (say) 85% of the size the CSS asked for, while `measureText`
 * on a canvas, and the page picture itself, stay at 100%.
 *
 * The spans then start on the right word — `left` is a percentage of the page,
 * which no font touches — and fall short of it by that much at the other end.
 * Everything the reader can select is measured from those spans, so a swept
 * quote comes back ending a fifth of the way early, and the confirm block and
 * the underline stop mid-line with the rest of the words outside them.
 *
 * The remeasure closes the loop in the DOM instead: ask each span how wide it
 * *actually* came out and re-derive `--scale-x` from that, against the width
 * the text content says the item is. It is the same correction pdf.js intended,
 * taken from the surface that has to match rather than from a canvas that does
 * not, so it is right whatever the platform is doing to fonts — text zoom, a
 * minimum font size, or a family the canvas does not have.
 */

/** One span, as measured on screen against the width its item should be. */
export interface TextSpanFit {
  /** Width the glyphs occupy on screen, from the text content. */
  want: number;
  /** Width the span's box actually came out, with `scaleX` as it stands. */
  measured: number;
  /** `--scale-x` pdf.js left on the span; 1 when it set none. */
  scaleX: number;
}

/**
 * Widths this far apart are the same width.
 *
 * Sub-pixel text metrics never land exactly, and rewriting every span on every
 * page to move a box a hundredth of a pixel is work for nothing. A platform
 * that is scaling text is out by percent, not by fractions of one.
 */
const REFIT_EPSILON = 0.005;

/** Scale factors outside this range are a measurement gone wrong, not a fit. */
const REFIT_MIN = 0.05;
const REFIT_MAX = 20;

/**
 * The `--scale-x` that makes this span as wide as its glyphs, or `null` to
 * leave it alone.
 *
 * `null` for a span with no width to measure (an empty string, a zero-width
 * item), for one that already fits, and for a correction so large that the
 * measurement it came from cannot be trusted — a span that has not been laid
 * out yet reports zero, and dividing by it would put a garbage transform on
 * text that is merely late.
 */
export function refitScaleX({ want, measured, scaleX }: TextSpanFit): number | null {
  if (!Number.isFinite(want) || !Number.isFinite(measured) || !Number.isFinite(scaleX)) {
    return null;
  }
  if (want <= 0 || measured <= 0 || scaleX <= 0) return null;
  const ratio = want / measured;
  if (Math.abs(ratio - 1) <= REFIT_EPSILON) return null;
  const next = scaleX * ratio;
  if (!(next >= REFIT_MIN && next <= REFIT_MAX)) return null;
  return next;
}

/**
 * As much of a `getTextContent()` item as the fit needs.
 *
 * The marked-content markers in that list are shaped nothing like a string
 * item, so `type` is here to let both kinds through one parameter — the fit
 * itself only ever reads `str` and `width`.
 */
export interface PdfTextItem {
  str?: string;
  width?: number;
  type?: string;
}

/**
 * Scene-to-screen scale of a laid-out page, or 0 when it has no layout yet.
 *
 * Both sides of the fit are in screen pixels — the measured box because that is
 * what `getBoundingClientRect` answers, the wanted width because it is derived
 * here — so the camera's zoom cancels out of the ratio. It still has to be
 * applied to both, because a page inside a scaled slot reports scaled boxes.
 */
export function pageScreenScale(page: HTMLElement): number {
  const layout = page.offsetWidth;
  if (layout <= 0) return 0;
  const rendered = page.getBoundingClientRect().width;
  return rendered > 0 ? rendered / layout : 0;
}

/**
 * The text items a span was made for.
 *
 * `getTextContent()` interleaves marked-content markers with the strings, and
 * only the strings get a span — so the lists index together after the markers
 * are dropped, and not before. Pairing the raw list against `textDivs` walks
 * off by one marker and re-fits every span to the wrong item's width.
 */
export function spannedItems(items: readonly PdfTextItem[]): PdfTextItem[] {
  return items.filter((item) => typeof item?.str === "string");
}

/**
 * Re-fit every span in a rendered text layer to the glyphs under it.
 *
 * `spans` is `TextLayer.textDivs`, which carries one entry per text item in
 * content order — including the empty ones it never appends — so the two lists
 * index together once the marked-content markers are out of the way. Reads are
 * taken in one pass and writes in another: the read of the first box is the
 * only forced layout, and interleaving them would make it one per span.
 *
 * Returns how many spans were changed, which is zero on a platform that is not
 * doing anything to fonts — the common case, and free.
 */
export function alignTextLayerToGlyphs(
  page: HTMLElement,
  spans: readonly HTMLElement[],
  items: readonly PdfTextItem[],
  fit: number,
): number {
  const scale = pageScreenScale(page);
  if (!(scale > 0) || !(fit > 0)) return 0;

  const strings = spannedItems(items);
  const pending: Array<{ span: HTMLElement; want: number; scaleX: number; measured: number }> = [];
  const upto = Math.min(spans.length, strings.length);
  for (let i = 0; i < upto; i += 1) {
    const span = spans[i];
    const item = strings[i];
    if (!span?.isConnected) continue;
    if (!item?.str?.trim()) continue;
    if (!(typeof item.width === "number" && item.width > 0)) continue;
    /*
     * Rotated and vertical text is left as pdf.js drew it. Its box is the
     * bounding box of a turned line, so the width in it is not the width of
     * the string, and the ratio would be nonsense.
     */
    if (span.style.getPropertyValue("--rotate")) continue;
    const scaleX = Number(span.style.getPropertyValue("--scale-x")) || 1;
    pending.push({ span, want: item.width * fit * scale, scaleX, measured: 0 });
  }

  for (const entry of pending) {
    entry.measured = entry.span.getBoundingClientRect().width;
  }

  let changed = 0;
  for (const entry of pending) {
    const next = refitScaleX(entry);
    if (next === null) continue;
    entry.span.style.setProperty("--scale-x", String(next));
    changed += 1;
  }
  return changed;
}
