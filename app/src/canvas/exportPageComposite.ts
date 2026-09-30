/**
 * Composite the DOM document / marks layers into a board export canvas.
 *
 * Toolbar capture historically painted Excalidraw + raster ink only. On md /
 * PDF / statement pages the readable body lives under a transparent canvas in
 * `.lc-page-content-slot`, and highlights / footnotes sit in
 * `.lc-page-marks-slot`. Without this step, captures are ink on black/transparent.
 */

import type { SceneBounds } from "./rasterInk";

export interface PageExportLayers {
  contentSlot: HTMLElement | null;
  marksSlot: HTMLElement | null;
  /** Scene rect of the open page (slot origin = min corner). */
  pageBounds: SceneBounds | null;
  /** Theme / CSS paper when Excalidraw viewBackground is transparent. */
  paperColor: string;
}

/** Never fill export with transparent — gallery apps show that as black. */
export function resolveExportPaperColor(
  viewBackground: string | undefined | null,
  paperColor: string,
): string {
  if (!viewBackground || viewBackground === "transparent") {
    return paperColor || "#ffffff";
  }
  return viewBackground;
}

function intersectBounds(a: SceneBounds, b: SceneBounds): SceneBounds | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * The app's CSS, collected once until a stylesheet is added or changes size.
 *
 * Every DOM capture embeds all of it; reading tens of thousands of rules back
 * out of the CSSOM each time cost more than drawing the capture.
 */
let stylesheetCache: { key: string; text: string } | null = null;

function stylesheetKey(): string {
  let rules = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      rules += sheet.cssRules?.length ?? 0;
    } catch {
      /* cross-origin */
    }
  }
  return `${document.styleSheets.length}:${rules}`;
}

function collectStylesheetText(): string {
  const key = stylesheetKey();
  if (stylesheetCache?.key === key) return stylesheetCache.text;
  const text = readStylesheetText();
  stylesheetCache = { key, text };
  return text;
}

function readStylesheetText(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        parts.push(rule.cssText);
      }
    } catch {
      /* cross-origin sheets throw — skip */
    }
  }
  return parts.join("\n");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("export layer image failed"));
    img.src = url;
  });
}

/** Marks the stand-in for `<html>` inside a captured SVG. */
const CAPTURE_ROOT_CLASS = "lc-capture-root";

/**
 * Layout-neutral inline style for the stand-in ancestors. They exist only so
 * that descendant selectors (`.lc-canvas-wrap .lc-md-ink-doc …`) and inherited
 * values still reach the clone; they must not add boxes, offsets or paint.
 *
 * Nor hide it. The classes copied up the chain include transient ones — the
 * app booting, a pane loading or preparing — whose rules hide or fade the
 * board. A picture taken then would be blank, and a page turn keeps its
 * pictures, so the blank sheet came back on every turn after it. An SVG image
 * also freezes animations on their first frame, which for a fade-in is
 * nothing at all.
 */
const SHELL_NEUTRAL =
  "display:block;position:static;transform:none;overflow:visible;" +
  "width:auto;height:auto;min-width:0;min-height:0;max-width:none;max-height:none;" +
  "margin:0;padding:0;border:0;background:transparent;box-shadow:none;" +
  "filter:none;opacity:1;visibility:visible;animation:none;transition:none;" +
  "inset:auto;contain:none;";

/**
 * Theme rules key off `<html data-theme>`. Inside the SVG image `:root` is the
 * `<svg>` and there is no `<html>`, so point those selectors at the stand-in.
 */
function themeScopedCss(css: string): string {
  return css.replace(/(?::root|\bhtml)(?=\[data-theme)/g, `.${CAPTURE_ROOT_CLASS}`);
}

/**
 * Stand-ins for the slot's real ancestors, `<html>` outermost, each carrying
 * the original's classes and `data-*` attributes so the app's scoped rules
 * match the clone the way they match the live page. The outermost also takes
 * every custom property the document root resolves — the theme sets its
 * palette as inline style on `<html>`, which no stylesheet carries — and the
 * innermost takes the inherited text settings of the slot's parent.
 */
function ancestorShell(slot: HTMLElement): { outer: HTMLElement; inner: HTMLElement } {
  const chain: Element[] = [];
  for (let el = slot.parentElement; el; el = el.parentElement) chain.unshift(el);
  const outer = document.createElement("div");
  let inner = outer;
  chain.forEach((source, index) => {
    const node = index === 0 ? outer : document.createElement("div");
    const classes = source.getAttribute("class");
    if (classes) node.setAttribute("class", classes);
    for (const attr of Array.from(source.attributes)) {
      if (attr.name.startsWith("data-")) node.setAttribute(attr.name, attr.value);
    }
    node.setAttribute("style", SHELL_NEUTRAL);
    if (index > 0) {
      inner.appendChild(node);
      inner = node;
    }
  });
  outer.classList.add(CAPTURE_ROOT_CLASS);

  const rootStyle = getComputedStyle(document.documentElement);
  const vars: string[] = [];
  for (let i = 0; i < rootStyle.length; i += 1) {
    const name = rootStyle.item(i);
    if (name.startsWith("--")) vars.push(`${name}:${rootStyle.getPropertyValue(name)}`);
  }
  outer.setAttribute("style", `${SHELL_NEUTRAL}${vars.join(";")}`);

  const parent = slot.parentElement;
  if (parent) {
    const text = getComputedStyle(parent);
    inner.style.color = text.color;
    inner.style.fontFamily = text.fontFamily;
    inner.style.fontSize = text.fontSize;
    inner.style.lineHeight = text.lineHeight;
    inner.style.letterSpacing = text.letterSpacing;
  }
  return { outer, inner };
}

const fontDataUrls = new Map<string, Promise<string | null>>();

function fontDataUrl(url: string): Promise<string | null> {
  let pending = fontDataUrls.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) =>
        blob
          ? new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          })
          : null,
      )
      .catch(() => null);
    fontDataUrls.set(url, pending);
  }
  return pending;
}

let fontCssCache: { key: string; css: Promise<string> } | null = null;

/**
 * `@font-face` rules for the faces the page has actually loaded, with their
 * files inlined. An SVG drawn as an image may not fetch anything, so the
 * stylesheet's `url(./fonts/…)` faces silently fall back to the default serif
 * — which is what made captured markdown pages look like a different app.
 */
function embeddedFontCss(): Promise<string> {
  const loaded = new Set<string>();
  document.fonts?.forEach((face) => {
    if (face.status === "loaded") loaded.add(`${face.family.replace(/["']/g, "")}|${face.weight}|${face.style}`);
  });
  const key = Array.from(loaded).sort().join(",");
  if (fontCssCache?.key === key) return fontCssCache.css;

  const jobs: Promise<string>[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const style = rule.style;
      const family = style.getPropertyValue("font-family").trim().replace(/["']/g, "");
      const weight = style.getPropertyValue("font-weight").trim() || "normal";
      const fontStyle = style.getPropertyValue("font-style").trim() || "normal";
      const matches = Array.from(loaded).some((entry) => entry.startsWith(`${family}|`));
      if (!family || !matches) continue;
      const src = style.getPropertyValue("src").match(/url\((['"]?)([^'")]+)\1\)/);
      if (!src?.[2] || src[2].startsWith("data:")) continue;
      let url: string;
      try {
        url = new URL(src[2], base).href;
      } catch {
        continue;
      }
      jobs.push(
        fontDataUrl(url).then((data) =>
          data
            ? `@font-face{font-family:"${family}";font-style:${fontStyle};font-weight:${weight};src:url("${data}");}`
            : "",
        ),
      );
    }
  }
  const css = Promise.all(jobs).then((faces) => faces.filter(Boolean).join("\n"));
  fontCssCache = { key, css };
  return css;
}

/**
 * Rasterize an HTML subtree (slot-local CSS = scene units) into the export
 * canvas for the overlapping scene rect.
 */
async function drawDomSlot(
  ctx: CanvasRenderingContext2D,
  slot: HTMLElement,
  pageBounds: SceneBounds,
  exportBounds: SceneBounds,
  drawScale: number,
): Promise<boolean> {
  const overlap = intersectBounds(pageBounds, exportBounds);
  if (!overlap) return false;

  const localX = overlap.minX - pageBounds.minX;
  const localY = overlap.minY - pageBounds.minY;
  const sceneW = overlap.maxX - overlap.minX;
  const sceneH = overlap.maxY - overlap.minY;
  const pixelW = Math.max(1, Math.round(sceneW * drawScale));
  const pixelH = Math.max(1, Math.round(sceneH * drawScale));

  const clone = slot.cloneNode(true) as HTMLElement;
  hollowOutside(slot, clone, overlap.minY - pageBounds.minY, overlap.maxY - pageBounds.minY);
  clone.style.transform = "none";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.position = "static";
  clone.style.margin = "0";
  clone.removeAttribute("aria-hidden");

  const css = themeScopedCss(collectStylesheetText()) + "\n" + (await embeddedFontCss());
  const wrapper = document.createElement("div");
  // At least the slot's own layout box: the marks layer runs wider than the
  // page, and anything past the frame would be clipped off the picture.
  const boxW = Math.max(pageBounds.maxX - pageBounds.minX, slot.offsetWidth);
  const boxH = Math.max(pageBounds.maxY - pageBounds.minY, slot.offsetHeight);
  wrapper.style.width = `${boxW}px`;
  wrapper.style.height = `${boxH}px`;
  wrapper.style.position = "relative";
  wrapper.style.overflow = "hidden";
  wrapper.style.background = "transparent";
  wrapper.appendChild(clone);
  const shell = ancestorShell(slot);
  shell.inner.appendChild(wrapper);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelW}" height="${pixelH}" ` +
    `viewBox="${localX} ${localY} ${sceneW} ${sceneH}">` +
    `<style type="text/css"><![CDATA[${css}]]></style>` +
    `<foreignObject x="0" y="0" width="${boxW}" ` +
    `height="${boxH}">${new XMLSerializer().serializeToString(shell.outer)}</foreignObject></svg>`;

  // Chromium/WebView marks a blob-backed SVG containing foreignObject as
  // origin-unclean even when every node is local. Drawing it succeeds, but the
  // final PNG encode then throws SecurityError (including otherwise clean PDF
  // captures with a marks layer). A self-contained data SVG stays exportable.
  // XML serialization also closes HTML void elements for the SVG image parser.
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const dx = (overlap.minX - exportBounds.minX) * drawScale;
  const dy = (overlap.minY - exportBounds.minY) * drawScale;
  ctx.drawImage(img, dx, dy, pixelW, pixelH);
  // Do not turn a failed document layer into a successful blank screenshot.
  return true;
}

const CAPTURE_METRICS = [
  "font-size", "line-height", "letter-spacing", "word-spacing",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "top", "right", "bottom", "left", "vertical-align",
] as const;

/** SVG images do not inherit Android WebView's system text zoom. Preserve
 * resolved type AND em-based geometry, or the fold rewraps the live page. */
function freezeCaptureMetrics(from: Element, to: Element): void {
  const style = (to as HTMLElement).style;
  if (!style) return;
  const resolved = getComputedStyle(from);
  for (const name of CAPTURE_METRICS) {
    style.setProperty(name, resolved.getPropertyValue(name));
  }
}

/**
 * Empty the parts of a cloned document that are nowhere near the capture.
 *
 * A capture of one screen of a long document used to serialise the whole
 * document into the SVG. Blocks entirely outside the band (in the slot's own,
 * unscaled coordinates) keep their box — same element, same margins, fixed to
 * the height they had — and lose their contents, so everything inside the
 * band still lays out exactly where it was.
 */
function hollowOutside(slot: HTMLElement, clone: HTMLElement, bandTop: number, bandBottom: number): void {
  const slotRect = slot.getBoundingClientRect();
  const scale = slot.offsetWidth > 0 ? slotRect.width / slot.offsetWidth : 1;
  if (!(scale > 0)) return;
  const margin = (bandBottom - bandTop) * 0.5;
  const top = bandTop - margin;
  const bottom = bandBottom + margin;
  const walk = (original: Element, copy: Element, depth: number) => {
    freezeCaptureMetrics(original, copy);
    const originals = original.children;
    const copies = copy.children;
    if (originals.length !== copies.length) return;
    for (let i = 0; i < originals.length; i += 1) {
      const from = originals[i]!;
      const to = copies[i]! as HTMLElement;
      const box = depth < 6 ? from.getBoundingClientRect() : null;
      const localTop = box ? (box.top - slotRect.top) / scale : top;
      const localBottom = box ? (box.bottom - slotRect.top) / scale : bottom;
      if (box && (localBottom < top || localTop > bottom)) {
        if (from instanceof HTMLElement && from.offsetHeight > 0) {
          freezeCaptureMetrics(from, to);
          // offsetHeight rounds every paragraph to whole CSS pixels. On a
          // long capture those errors accumulate above the selected passage,
          // moving the text while ink keeps its exact scene coordinates.
          to.style.height = `${box.height / scale}px`;
          to.style.boxSizing = "border-box";
          to.style.overflow = "hidden";
          to.replaceChildren();
        }
        continue;
      }
      // Freeze only the retained band, never every glyph in the full document.
      walk(from, to, depth + 1);
    }
  };
  walk(slot, clone, 0);
}

/**
 * Draw PDF page bitmaps that already exist in the content slot. More reliable
 * than foreignObject for canvas elements (clones are blank).
 */
function drawPdfCanvases(
  ctx: CanvasRenderingContext2D,
  slot: HTMLElement,
  pageBounds: SceneBounds,
  exportBounds: SceneBounds,
  drawScale: number,
): boolean {
  const canvases = slot.querySelectorAll<HTMLCanvasElement>("canvas.lc-pdf-canvas");
  if (canvases.length === 0) return false;

  const slotRect = slot.getBoundingClientRect();
  // The slot is laid out in scene units and only scaled, so its layout width
  // against its client width is the zoom — whatever width the frame has.
  const layoutW = slot.offsetWidth > 0 ? slot.offsetWidth : Math.max(1, pageBounds.maxX - pageBounds.minX);
  const zoom = slotRect.width > 0 ? slotRect.width / layoutW : 1;

  let drew = false;
  for (const canvas of Array.from(canvases)) {
    if (canvas.width < 1 || canvas.height < 1) continue;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const localX = (rect.left - slotRect.left) / zoom;
    const localY = (rect.top - slotRect.top) / zoom;
    const localW = rect.width / zoom;
    const localH = rect.height / zoom;

    const scene: SceneBounds = {
      minX: pageBounds.minX + localX,
      minY: pageBounds.minY + localY,
      maxX: pageBounds.minX + localX + localW,
      maxY: pageBounds.minY + localY + localH,
    };
    const overlap = intersectBounds(scene, exportBounds);
    if (!overlap) continue;

    const srcScaleX = canvas.width / localW;
    const srcScaleY = canvas.height / localH;
    const sx = (overlap.minX - scene.minX) * srcScaleX;
    const sy = (overlap.minY - scene.minY) * srcScaleY;
    const sw = (overlap.maxX - overlap.minX) * srcScaleX;
    const sh = (overlap.maxY - overlap.minY) * srcScaleY;
    const dx = (overlap.minX - exportBounds.minX) * drawScale;
    const dy = (overlap.minY - exportBounds.minY) * drawScale;
    const dw = (overlap.maxX - overlap.minX) * drawScale;
    const dh = (overlap.maxY - overlap.minY) * drawScale;
    try {
      ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
      drew = true;
    } catch {
      /* tainted or detached canvas */
    }
  }
  return drew;
}

/**
 * Paint page content then annotation/marks layers under the Excalidraw + ink
 * stack. Safe no-op when there is no document slot.
 */
export async function compositePageLayers(
  ctx: CanvasRenderingContext2D,
  exportBounds: SceneBounds,
  drawScale: number,
  layers: PageExportLayers | null | undefined,
): Promise<void> {
  if (!layers?.pageBounds) return;
  const { pageBounds, contentSlot, marksSlot } = layers;
  if (!intersectBounds(pageBounds, exportBounds)) return;

  if (contentSlot) {
    const drewPdf = drawPdfCanvases(ctx, contentSlot, pageBounds, exportBounds, drawScale);
    // Markdown / statement: foreignObject. Also retry when PDF canvases were
    // blank or only partially drew — ink-only exports used to skip the DOM path.
    if (!drewPdf) {
      await drawDomSlot(ctx, contentSlot, pageBounds, exportBounds, drawScale);
    }
  }

  // Marks / highlights / footnotes always attempt independently of content path.
  if (marksSlot && marksSlot.childElementCount > 0) {
    await drawDomSlot(ctx, marksSlot, pageBounds, exportBounds, drawScale);
  }
}
