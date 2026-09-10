/**
 * Scene primitives on a 2D context — stamps, viz, and gesture shapes.
 *
 * Page frames stay data-only (camera / clip). Coach and student drawings paint.
 */

import { FONT_CODE, FONT_UI } from "../templates/skeleton";

export interface PaintSceneMeta {
  lcRegionFrame?: boolean;
  lcScratchFrame?: boolean;
  lcMdInkFrame?: boolean;
  lcDocumentPage?: boolean;
  lcVizId?: string;
  lcStamp?: boolean;
  lcStampGroup?: string;
}

export interface PaintSceneElement {
  id?: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  locked?: boolean;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  opacity?: number;
  roundness?: null | { type: number };
  points?: Array<[number, number]>;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  lineHeight?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  fileId?: string;
  isDeleted?: boolean;
  customData?: PaintSceneMeta | null;
}

export interface PaintSceneFile {
  dataURL?: string;
  mimeType?: string;
}

export interface PaintSceneOptions {
  files?: Record<string, PaintSceneFile | undefined>;
  images?: Record<string, CanvasImageSource | undefined>;
  /** Skip culling; paint every drawable element. */
  all?: boolean;
  view?: { minX: number; minY: number; maxX: number; maxY: number };
}

const PAINT_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "text",
  "image",
]);

export function isPageFrame(element: PaintSceneElement): boolean {
  const meta = element.customData;
  if (!meta) return false;
  return Boolean(
    meta.lcRegionFrame || meta.lcScratchFrame || meta.lcMdInkFrame || meta.lcDocumentPage,
  );
}

export function isDrawableSceneElement(element: PaintSceneElement): boolean {
  if (element.isDeleted) return false;
  if (!PAINT_TYPES.has(element.type)) return false;
  if (isPageFrame(element)) return false;
  const opacity = element.opacity ?? 100;
  if (opacity <= 0) return false;
  return true;
}

function fontFace(family: number | undefined): string {
  return family === FONT_CODE ? "ui-monospace, Cascadia Code, Consolas, monospace" : "Helvetica, Arial, sans-serif";
}

function applyStroke(ctx: CanvasRenderingContext2D, element: PaintSceneElement): void {
  const width = element.strokeWidth ?? 1;
  ctx.lineWidth = width;
  ctx.strokeStyle = element.strokeColor && element.strokeColor !== "transparent"
    ? element.strokeColor
    : "rgba(0,0,0,0)";
  const style = element.strokeStyle ?? "solid";
  if (style === "dashed") ctx.setLineDash([Math.max(4, width * 4), Math.max(3, width * 3)]);
  else if (style === "dotted") ctx.setLineDash([width, Math.max(3, width * 3)]);
  else ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}

function fillColor(element: PaintSceneElement): string | null {
  const fill = element.backgroundColor;
  if (!fill || fill === "transparent") return null;
  if (element.fillStyle === "hachure" || element.fillStyle === "cross-hatch") {
    return fill;
  }
  return fill;
}

function roundRadius(element: PaintSceneElement): number {
  if (!element.roundness) return 0;
  const w = Math.abs(element.width ?? 0);
  const h = Math.abs(element.height ?? 0);
  return Math.min(12, w / 4, h / 4);
}

function withElementTransform(
  ctx: CanvasRenderingContext2D,
  element: PaintSceneElement,
  draw: () => void,
): void {
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  const angle = element.angle ?? 0;
  ctx.save();
  const opacity = element.opacity ?? 100;
  ctx.globalAlpha *= Math.max(0, Math.min(1, opacity / 100));
  if (angle) {
    ctx.translate(element.x + w / 2, element.y + h / 2);
    ctx.rotate(angle);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(element.x, element.y);
  }
  draw();
  ctx.restore();
}

function paintBoxPath(ctx: CanvasRenderingContext2D, element: PaintSceneElement): void {
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  const r = roundRadius(element);
  ctx.beginPath();
  if (element.type === "ellipse") {
    ctx.ellipse(w / 2, h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (element.type === "diamond") {
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w, h / 2);
    ctx.lineTo(w / 2, h);
    ctx.lineTo(0, h / 2);
    ctx.closePath();
    return;
  }
  if (r > 0 && typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, w, h, r);
    return;
  }
  ctx.rect(0, 0, w, h);
}

function paintFillAndStroke(ctx: CanvasRenderingContext2D, element: PaintSceneElement): void {
  const fill = fillColor(element);
  applyStroke(ctx, element);
  if (fill) {
    ctx.fillStyle = fill;
    if (element.fillStyle === "hachure" || element.fillStyle === "cross-hatch") {
      ctx.globalAlpha *= 0.35;
      ctx.fill();
      ctx.globalAlpha /= 0.35;
    } else {
      ctx.fill();
    }
  }
  if ((element.strokeWidth ?? 1) > 0 && element.strokeColor && element.strokeColor !== "transparent") {
    ctx.stroke();
  }
}

function paintBoundLabel(
  ctx: CanvasRenderingContext2D,
  box: PaintSceneElement,
  label: PaintSceneElement,
): void {
  const text = label.text ?? "";
  if (!text) return;
  const w = box.width ?? 0;
  const h = box.height ?? 0;
  const fontSize = label.fontSize ?? 16;
  const lines = text.split("\n");
  const lineHeight = fontSize * (label.lineHeight ?? 1.25);
  ctx.save();
  ctx.fillStyle = label.strokeColor && label.strokeColor !== "transparent" ? label.strokeColor : "#1e1e1e";
  ctx.font = `${fontSize}px ${fontFace(label.fontFamily ?? FONT_UI)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxWidth = Math.max(8, (box.type === "diamond" ? w * 0.6 : w) - 12);
  const startY = h / 2 - (lines.length - 1) * lineHeight / 2;
  lines.forEach((line, index) => ctx.fillText(line, w / 2, startY + index * lineHeight, maxWidth));
  ctx.restore();
}

function paintFreeText(ctx: CanvasRenderingContext2D, element: PaintSceneElement): void {
  const text = element.text ?? "";
  if (!text) return;
  const fontSize = element.fontSize ?? 20;
  const lineHeight = (element.lineHeight ?? 1.25) * fontSize;
  const align = element.textAlign ?? "left";
  const valign = element.verticalAlign ?? "top";
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  ctx.save();
  ctx.fillStyle = element.strokeColor && element.strokeColor !== "transparent" ? element.strokeColor : "#1e1e1e";
  ctx.font = `${fontSize}px ${fontFace(element.fontFamily)}`;
  ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  ctx.textBaseline = "top";
  const x = align === "center" ? w / 2 : align === "right" ? w : 0;
  const lines = text.split("\n");
  let y = 0;
  if (valign === "middle") y = (h - lines.length * lineHeight) / 2;
  else if (valign === "bottom") y = h - lines.length * lineHeight;
  for (const line of lines) {
    ctx.fillText(line, x, y, w > 0 ? w : undefined);
    y += lineHeight;
  }
  ctx.restore();
}

function paintLinear(ctx: CanvasRenderingContext2D, element: PaintSceneElement): void {
  const pts = element.points;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha *= (element.opacity ?? 100) / 100;
  ctx.translate(element.x, element.y);
  applyStroke(ctx, element);
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.stroke();
  if (element.type === "arrow") {
    const a = pts[pts.length - 2]!;
    const b = pts[pts.length - 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const size = Math.max(10, (element.strokeWidth ?? 2) * 4);
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - ux * size + px * size * 0.45, b[1] - uy * size + py * size * 0.45);
    ctx.lineTo(b[0] - ux * size - px * size * 0.45, b[1] - uy * size - py * size * 0.45);
    ctx.closePath();
    ctx.fillStyle = element.strokeColor && element.strokeColor !== "transparent" ? element.strokeColor : "#1e1e1e";
    ctx.fill();
  }
  ctx.restore();
}

function inView(element: PaintSceneElement, view: PaintSceneOptions["view"]): boolean {
  if (!view) return true;
  // Auto-sized text has no reliable bounds until it is measured by the painter.
  if (element.type === "text" && (!element.width || !element.height)) return true;
  const { x, y } = element;
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  let minX = Math.min(x, x + w);
  let minY = Math.min(y, y + h);
  let maxX = Math.max(x, x + w);
  let maxY = Math.max(y, y + h);
  if (element.points) {
    for (const pt of element.points) {
      minX = Math.min(minX, x + pt[0]);
      minY = Math.min(minY, y + pt[1]);
      maxX = Math.max(maxX, x + pt[0]);
      maxY = Math.max(maxY, y + pt[1]);
    }
  } else if (element.angle) {
    const cos = Math.abs(Math.cos(element.angle));
    const sin = Math.abs(Math.sin(element.angle));
    const rx = (Math.abs(w) * cos + Math.abs(h) * sin) / 2;
    const ry = (Math.abs(w) * sin + Math.abs(h) * cos) / 2;
    minX = x + w / 2 - rx;
    maxX = x + w / 2 + rx;
    minY = y + h / 2 - ry;
    maxY = y + h / 2 + ry;
  }
  const bleed = Math.max(12, element.strokeWidth ?? 1);
  return minX - bleed <= view.maxX && minY - bleed <= view.maxY &&
    maxX + bleed >= view.minX && maxY + bleed >= view.minY;
}

/**
 * Paint drawable scene elements in scene coordinates. Caller sets the transform.
 */
export function paintSceneElements(
  ctx: CanvasRenderingContext2D,
  elements: readonly PaintSceneElement[],
  opts: PaintSceneOptions = {},
): void {
  const drawable = elements.filter(isDrawableSceneElement);
  const byId = new Map<string, PaintSceneElement>();
  for (const el of drawable) {
    if (el.id) byId.set(el.id, el);
  }
  const bound = new Map<string, PaintSceneElement[]>();
  const rest: PaintSceneElement[] = [];
  for (const el of drawable) {
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      const list = bound.get(el.containerId) ?? [];
      list.push(el);
      bound.set(el.containerId, list);
      continue;
    }
    if (opts.view && !opts.all && !inView(el, opts.view)) continue;
    rest.push(el);
  }

  const lines = rest.filter((el) => el.type === "line" || el.type === "arrow");
  const boxes = rest.filter(
    (el) => el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond",
  );
  const images = rest.filter((el) => el.type === "image");
  const texts = rest.filter((el) => el.type === "text");

  for (const el of lines) paintLinear(ctx, el);
  for (const el of boxes) {
    withElementTransform(ctx, el, () => {
      paintBoxPath(ctx, el);
      paintFillAndStroke(ctx, el);
      const labels = el.id ? bound.get(el.id) : undefined;
      if (labels) {
        for (const label of labels) paintBoundLabel(ctx, el, label);
      }
    });
  }
  for (const el of images) {
    const source = el.fileId ? opts.images?.[el.fileId] : undefined;
    if (!source) continue;
    withElementTransform(ctx, el, () => {
      const w = el.width ?? 0;
      const h = el.height ?? 0;
      try {
        ctx.drawImage(source, 0, 0, w, h);
      } catch {
        /* decode not ready */
      }
    });
  }
  for (const el of texts) {
    withElementTransform(ctx, el, () => paintFreeText(ctx, el));
  }
}

export function paintSceneToExport(
  ctx: CanvasRenderingContext2D,
  elements: readonly unknown[],
  opts: {
    minX: number;
    minY: number;
    padding: number;
    exportScale: number;
    files?: Record<string, PaintSceneFile | undefined>;
    images?: Record<string, CanvasImageSource | undefined>;
  },
): void {
  ctx.save();
  ctx.scale(opts.exportScale, opts.exportScale);
  ctx.translate(opts.padding - opts.minX, opts.padding - opts.minY);
  paintSceneElements(ctx, elements as PaintSceneElement[], {
    files: opts.files,
    images: opts.images,
    all: true,
  });
  ctx.restore();
}

/** Viewport → scene transform used by the live overlay. Caller must clear. */
export function applyViewportTransform(
  ctx: CanvasRenderingContext2D,
  viewport: {
    zoom: number;
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
  },
  dpr: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  ctx.setTransform(dpr * viewport.zoom, 0, 0, dpr * viewport.zoom, 0, 0);
  ctx.translate(viewport.scrollX, viewport.scrollY);
  const minX = -viewport.scrollX;
  const minY = -viewport.scrollY;
  return {
    minX,
    minY,
    maxX: minX + viewport.width / viewport.zoom,
    maxY: minY + viewport.height / viewport.zoom,
  };
}
