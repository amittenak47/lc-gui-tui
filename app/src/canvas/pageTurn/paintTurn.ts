/**
 * Draw one frame of a page turn.
 *
 * Always drawn as a turn *from* one picture *to* another with the lifted corner
 * somewhere between rest (`x = w`, nothing turned) and fully over (`x = -w`).
 * Turning back is the same drawing: from the previous page to this one,
 * starting fully over — see `cornerForCrease`.
 *
 *   - **sheet** — one page fills the view, bound along its left edge. The page
 *     underneath shows through as the sheet lifts away, and the back of the
 *     sheet is paper with the print showing faintly through it.
 *   - **book** — an open book: two pages side by side, bound in the middle.
 *     The right-hand page lifts and falls onto the left; its back is the left
 *     page of the spread being turned to, and the right page of that spread
 *     is what lies underneath.
 */

import { curlGeometry, foldReflection, sheetPart, type Point } from "./curl";

export type TurnLayout = "sheet" | "book";

export interface TurnFrame {
  layout: TurnLayout;
  /** View size in CSS pixels. */
  width: number;
  height: number;
  /**
   * The picture being turned away from, and the one being turned to.
   *
   * On a single sheet either may be null: the live page under the canvas is
   * that page, so its part of the drawing is left clear and the page itself
   * shows through. A book spread needs both.
   */
  from: CanvasImageSource | null;
  to: CanvasImageSource | null;
  /** Pixel size of the pictures, which may be at a different scale to the view. */
  sourceWidth: number;
  sourceHeight: number;
  /** The lifted corner, in the turning sheet's own coordinates. */
  corner: Point;
  bottom: boolean;
  /** Where on its free edge the sheet is held: a corner (0 or the height) unless taken by the side. */
  restY?: number;
  paper: string;
  /** Another sheet is turning underneath; paint only this sheet and its shadow. */
  sheetOnly?: boolean;
  /**
   * A softened copy of `to`, at any size. The page being turned to shows
   * through it at first and comes sharp as the sheet goes over — the eye is
   * on the turn, not the page, and a preview still at low resolution reads
   * as out of focus rather than pixelated.
   */
  toBlur?: CanvasImageSource | null;
}

/** How much of the softened page shows over the sharp one at this point of the turn. */
export function underBlur(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return Math.pow(1 - p, 1.4);
}

/** Rows a sheet held by its side is drawn in: its fold is a curve, sampled this finely. */
const SIDE_ROWS = 48;

/** A single sheet held somewhere along its side, not at a corner: see `sideFold`. */
function heldBySide(frame: Pick<TurnFrame, "layout" | "height" | "restY">): boolean {
  return frame.layout === "sheet" && frame.restY != null && frame.restY > 0 && frame.restY < frame.height;
}

/**
 * A sheet taken by its side folds top to bottom, not from a corner.
 *
 * Paper pulled at one point of its edge leads with that point: the edge
 * there is ahead of the rest of it, which trails a little above and below,
 * and the fold bows the same way. At rest and fully over the edge is
 * straight again. Taken near a corner, the far end trails most and the fold
 * leans toward that corner, much as a corner peel does.
 *
 * `fold[i]` and `edge[i]` are the fold and the folded-over free edge at row
 * `ys[i]`, in view pixels; the parts are the polygons between them.
 */
function sideFold(frame: Pick<TurnFrame, "width" | "height" | "corner" | "restY">) {
  const { width: W, height: H } = frame;
  const restY = frame.restY ?? H / 2;
  const progress = Math.min(1, Math.max(0, (W - frame.corner.x) / (2 * W)));
  const lift = Math.sin(Math.PI * progress);
  const lag = lift * Math.min(W * 0.18, 90);
  const spread = H * 0.45;
  const ys: number[] = [];
  const fold: Point[] = [];
  const edge: Point[] = [];
  for (let i = 0; i <= SIDE_ROWS; i += 1) {
    const y = (H * i) / SIDE_ROWS;
    const away = (y - restY) / spread;
    const edgeX = frame.corner.x + lag * (1 - Math.exp(-away * away));
    const foldX = Math.min(W, (W + edgeX) / 2);
    ys.push(y);
    fold.push({ x: foldX, y });
    edge.push({ x: 2 * foldX - W, y });
  }
  const flat: Point[] = [{ x: 0, y: 0 }, ...fold, { x: 0, y: H }];
  const open: Point[] = [{ x: W, y: 0 }, ...fold, { x: W, y: H }];
  const flap: Point[] = [...fold, ...edge.slice().reverse()];
  return { progress, lift, restY, ys, fold, edge, flat, open, flap };
}

/** Paint a sheet held by its side: see `sideFold`. */
function paintSideFold(ctx: CanvasRenderingContext2D, frame: TurnFrame): number {
  const { width: W, height: H } = frame;
  const f = sideFold(frame);
  const { lift } = f;
  const span = Math.max(16, W * (0.035 + 0.085 * lift));
  // Rows meet on whole device pixels: overlapping, their shading doubled
  // into lines across the page; apart, they left gaps.
  const unit = Math.abs(ctx.getTransform?.().d ?? 1) || 1;
  const snap = (y: number) => Math.round(y * unit) / unit;
  const top = (i: number) => snap(f.ys[i]!);
  const rowH = (i: number) => top(i + 1) - top(i);
  ctx.clearRect(0, 0, W, H);

  // The page being turned to, where the sheet has come off it.
  ctx.save();
  tracePolygon(ctx, f.open);
  ctx.clip();
  if (!frame.sheetOnly) drawUnder(ctx, frame, f.progress, 0, 1, 0, W);
  if (f.progress > 0) {
    // The shadow the lifted sheet casts on it, along the fold row by row.
    const shadow = ctx.createLinearGradient(0, 0, span * 1.6, 0);
    shadow.addColorStop(0, `rgba(0,0,0,${0.23 * lift})`);
    shadow.addColorStop(0.25, `rgba(0,0,0,${0.12 * lift})`);
    shadow.addColorStop(0.65, `rgba(0,0,0,${0.035 * lift})`);
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadow;
    for (let i = 0; i < SIDE_ROWS; i += 1) {
      ctx.save();
      ctx.translate(f.fold[i]!.x, 0);
      ctx.fillRect(0, top(i), span * 1.6, rowH(i));
      ctx.restore();
    }
  }
  ctx.restore();

  // The sheet still lying flat, bending up toward the fold.
  ctx.save();
  tracePolygon(ctx, f.flat);
  ctx.clip();
  drawSlice(ctx, frame, frame.from, 0, 1, 0, W);
  if (f.progress > 0) {
    const bend = ctx.createLinearGradient(0, 0, -span * 0.6, 0);
    bend.addColorStop(0, `rgba(0,0,0,${0.11 * lift})`);
    bend.addColorStop(0.3, `rgba(0,0,0,${0.035 * lift})`);
    bend.addColorStop(0.65, `rgba(255,255,255,${0.035 * lift})`);
    bend.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bend;
    for (let i = 0; i < SIDE_ROWS; i += 1) {
      ctx.save();
      ctx.translate(f.fold[i]!.x, 0);
      ctx.fillRect(-span * 0.6, top(i), span * 0.6, rowH(i));
      ctx.restore();
    }
  }
  ctx.restore();

  // The flap: the back of the sheet, folded over.
  if (f.progress > 0) {
    ctx.save();
    tracePolygon(ctx, f.flap);
    ctx.clip();
    ctx.fillStyle = frame.paper;
    ctx.fillRect(0, 0, W, H);
    if (frame.from) {
      // Print showing through from the front, mirrored about the fold row by row.
      ctx.globalAlpha = 0.1;
      for (let i = 0; i < SIDE_ROWS; i += 1) {
        const x = f.fold[i]!.x;
        ctx.save();
        ctx.beginPath();
        ctx.rect(-W, top(i), 3 * W, rowH(i));
        ctx.clip();
        ctx.translate(2 * x, 0);
        ctx.scale(-1, 1);
        drawSlice(ctx, frame, frame.from, 0, 1, 0, W);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    // The curve of the paper: light along the fold, strongest where it is held.
    for (let i = 0; i < SIDE_ROWS; i += 1) {
      const away = (top(i) + rowH(i) / 2 - f.restY) / (H * 0.18);
      const pinch = 1 + 0.6 * Math.exp(-away * away);
      const curve = ctx.createLinearGradient(0, 0, -span * 1.4, 0);
      curve.addColorStop(0, `rgba(0,0,0,${0.06 * lift * pinch})`);
      curve.addColorStop(0.12, `rgba(255,255,255,${Math.min(0.5, 0.28 * lift * pinch)})`);
      curve.addColorStop(0.38, `rgba(255,255,255,${0.1 * lift})`);
      curve.addColorStop(0.72, `rgba(0,0,0,${0.065 * lift})`);
      curve.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = curve;
      ctx.save();
      ctx.translate(f.fold[i]!.x, 0);
      ctx.fillRect(-span * 1.4, top(i), span * 1.4, rowH(i));
      ctx.restore();
    }
    ctx.restore();
    // The sheet's free edge, a fine line over the page beneath.
    ctx.save();
    ctx.beginPath();
    f.edge.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `rgba(0,0,0,${0.22 * lift})`;
    ctx.stroke();
    ctx.restore();
  }
  return f.progress;
}

function tracePolygon(ctx: CanvasRenderingContext2D, poly: readonly Point[]): void {
  ctx.beginPath();
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

/**
 * Draw part of a picture into a view-space rectangle.
 *
 * `sx` and `sw` are fractions of the picture's width, so a half page is
 * `0, 0.5` or `0.5, 0.5` whatever scale the picture was captured at.
 */
function drawSlice(
  ctx: CanvasRenderingContext2D,
  frame: TurnFrame,
  image: CanvasImageSource | null,
  sx: number,
  sw: number,
  dx: number,
  dw: number,
): void {
  if (!image) return;
  ctx.drawImage(
    image,
    sx * frame.sourceWidth,
    0,
    sw * frame.sourceWidth,
    frame.sourceHeight,
    dx,
    0,
    dw,
    frame.height,
  );
}

/** `frame.to` and, over it, its softened copy as far as the turn still blurs it. */
function drawUnder(
  ctx: CanvasRenderingContext2D,
  frame: TurnFrame,
  progress: number,
  sx: number,
  sw: number,
  dx: number,
  dw: number,
): void {
  drawSlice(ctx, frame, frame.to, sx, sw, dx, dw);
  const blur = frame.to && frame.toBlur ? underBlur(progress) : 0;
  if (blur <= 0.01) return;
  const soft = frame.toBlur as CanvasImageSource & { width: number; height: number };
  if (!(soft.width > 0) || !(soft.height > 0)) return;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * blur;
  ctx.drawImage(soft, sx * soft.width, 0, sw * soft.width, soft.height, dx, 0, dw, frame.height);
  ctx.globalAlpha = alpha;
}

/** The part of a single sheet still lying flat, in view pixels: the page it is turning away from. */
export function flatSheet(
  frame: Pick<TurnFrame, "layout" | "width" | "height" | "corner" | "bottom" | "restY">,
): Point[] {
  if (heldBySide(frame)) return sideFold(frame).flat;
  const g = curlGeometry(frame.corner, frame.width, frame.height, frame.bottom, frame.restY);
  return sheetPart(g, frame.width, frame.height, false);
}

export function paintTurn(ctx: CanvasRenderingContext2D, frame: TurnFrame): number {
  if (heldBySide(frame)) return paintSideFold(ctx, frame);
  const { width: W, height: H } = frame;
  const book = frame.layout === "book";
  const spine = book ? W / 2 : 0;
  const w = book ? W / 2 : W;
  const g = curlGeometry(frame.corner, w, H, frame.bottom, frame.restY);

  ctx.clearRect(0, 0, W, H);
  const flat = sheetPart(g, w, H, false);
  const flap = sheetPart(g, w, H, true);

  // What lies still: the page being turned to underneath, and in a book the
  // left page of the spread being left, until the flap covers it.
  if (frame.sheetOnly) {
    // The next turn supplies the backdrop, with its own page pictures.
  } else if (book) {
    drawSlice(ctx, frame, frame.from, 0, 0.5, 0, spine);
    drawUnder(ctx, frame, g.progress, 0.5, 0.5, spine, w);
  } else if (!frame.from && flat.length >= 3) {
    // The sheet still lying flat is the live page itself: leave it clear.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    flat.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip("evenodd");
    drawUnder(ctx, frame, g.progress, 0, 1, 0, W);
    ctx.restore();
  } else {
    drawUnder(ctx, frame, g.progress, 0, 1, 0, W);
  }

  ctx.save();
  ctx.translate(spine, 0);
  const n = g.foldNormal;
  const fp = g.foldPoint;
  // Lift is zero at either resting position. The shadow and bend broaden as
  // the sheet rises, then soften away as it lands instead of snapping off.
  const lift = Math.sin(Math.PI * g.progress);
  const span = Math.max(16, w * (0.035 + 0.085 * lift));

  // Shadow the flap casts on the page it is uncovering.
  if (g.progress > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, H);
    ctx.clip();
    const shadow = ctx.createLinearGradient(fp.x, fp.y, fp.x + n.x * span * 1.6, fp.y + n.y * span * 1.6);
    shadow.addColorStop(0, `rgba(0,0,0,${0.23 * lift})`);
    shadow.addColorStop(0.25, `rgba(0,0,0,${0.12 * lift})`);
    shadow.addColorStop(0.65, `rgba(0,0,0,${0.035 * lift})`);
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadow;
    ctx.fillRect(0, 0, w, H);
    ctx.restore();
  }

  // The part of the sheet still lying flat.
  if (flat.length >= 3) {
    ctx.save();
    tracePolygon(ctx, flat);
    ctx.clip();
    drawSlice(ctx, frame, frame.from, book ? 0.5 : 0, book ? 0.5 : 1, 0, w);
    // It bends up toward the fold, so it darkens a little there.
    if (g.progress > 0) {
      const bend = ctx.createLinearGradient(fp.x, fp.y, fp.x - n.x * span * 0.6, fp.y - n.y * span * 0.6);
      bend.addColorStop(0, `rgba(0,0,0,${0.11 * lift})`);
      bend.addColorStop(0.3, `rgba(0,0,0,${0.035 * lift})`);
      bend.addColorStop(0.65, `rgba(255,255,255,${0.035 * lift})`);
      bend.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bend;
      tracePolygon(ctx, flat);
      ctx.fill();
    }
    ctx.restore();
  }

  // The flap: the sheet folded back over, showing its other side.
  if (flap.length >= 3) {
    ctx.save();
    const [a, b, c, d, e, f] = foldReflection(g);
    ctx.transform(a, b, c, d, e, f);
    tracePolygon(ctx, flap);
    ctx.clip();
    if (book) {
      // The back of this page is the left page of the next spread, mirrored
      // into the sheet so it reads the right way round once it lands.
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      drawUnder(ctx, frame, g.progress, 0, 0.5, 0, w);
      ctx.restore();
    } else {
      ctx.fillStyle = frame.paper;
      ctx.fillRect(0, 0, w, H);
      // Print showing through from the front.
      ctx.globalAlpha = 0.1;
      drawSlice(ctx, frame, frame.from, 0, 1, 0, w);
      ctx.globalAlpha = 1;
    }
    // The curve of the paper: light along the fold, falling away from it.
    const far = { x: fp.x + n.x * span * 1.4, y: fp.y + n.y * span * 1.4 };
    const curve = ctx.createLinearGradient(fp.x, fp.y, far.x, far.y);
    curve.addColorStop(0, `rgba(0,0,0,${0.06 * lift})`);
    curve.addColorStop(0.12, `rgba(255,255,255,${0.28 * lift})`);
    curve.addColorStop(0.38, `rgba(255,255,255,${0.1 * lift})`);
    curve.addColorStop(0.72, `rgba(0,0,0,${0.065 * lift})`);
    curve.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = curve;
    tracePolygon(ctx, flap);
    ctx.fill();
    // A fine paper edge separates the folded sheet from the page beneath.
    // Clipping keeps the stroke inside the sheet and out of the text below.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `rgba(0,0,0,${0.22 * lift})`;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
  return g.progress;
}
