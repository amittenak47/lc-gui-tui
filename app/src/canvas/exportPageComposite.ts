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

function collectStylesheetText(): string {
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
  clone.style.transform = "none";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.position = "static";
  clone.style.margin = "0";
  clone.removeAttribute("aria-hidden");

  const css = collectStylesheetText();
  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.width = `${pageBounds.maxX - pageBounds.minX}px`;
  wrapper.style.height = `${pageBounds.maxY - pageBounds.minY}px`;
  wrapper.style.position = "relative";
  wrapper.style.overflow = "hidden";
  wrapper.style.background = "transparent";
  wrapper.appendChild(clone);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelW}" height="${pixelH}" ` +
    `viewBox="${localX} ${localY} ${sceneW} ${sceneH}">` +
    `<style type="text/css"><![CDATA[${css}]]></style>` +
    `<foreignObject x="0" y="0" width="${pageBounds.maxX - pageBounds.minX}" ` +
    `height="${pageBounds.maxY - pageBounds.minY}">${wrapper.outerHTML}</foreignObject></svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const dx = (overlap.minX - exportBounds.minX) * drawScale;
    const dy = (overlap.minY - exportBounds.minY) * drawScale;
    ctx.drawImage(img, dx, dy, pixelW, pixelH);
    return true;
  } catch (cause) {
    console.warn("[lc-export] drawDomSlot failed", cause);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
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
  const pageW = Math.max(1, pageBounds.maxX - pageBounds.minX);
  const zoom = slotRect.width > 0 ? slotRect.width / pageW : 1;

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
    // Markdown / statement: foreignObject. Skip when PDF bitmaps already drew
    // the page — avoid soft clones over sharp canvases.
    if (!drewPdf) {
      await drawDomSlot(ctx, contentSlot, pageBounds, exportBounds, drawScale);
    }
  }

  // Marks / highlights / footnotes always attempt independently of content path.
  if (marksSlot && marksSlot.childElementCount > 0) {
    await drawDomSlot(ctx, marksSlot, pageBounds, exportBounds, drawScale);
  }
}
