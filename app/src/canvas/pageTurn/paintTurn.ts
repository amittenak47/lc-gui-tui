/**
 * Draw one frame of a page turn.
 *
 * Always drawn as a turn *from* one picture *to* another with the lifted corner
 * somewhere between rest (`x = w`, nothing turned) and fully over (`x = -w`).
 * Turning back is the same drawing: from the previous page to this one,
 * starting fully over — see `cornerForDrag`.
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
  /** The picture being turned away from, and the one being turned to. */
  from: CanvasImageSource;
  to: CanvasImageSource;
  /** Pixel size of the pictures, which may be at a different scale to the view. */
  sourceWidth: number;
  sourceHeight: number;
  /** The lifted corner, in the turning sheet's own coordinates. */
  corner: Point;
  bottom: boolean;
  paper: string;
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
  image: CanvasImageSource,
  sx: number,
  sw: number,
  dx: number,
  dw: number,
): void {
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

export function paintTurn(ctx: CanvasRenderingContext2D, frame: TurnFrame): number {
  const { width: W, height: H } = frame;
  const book = frame.layout === "book";
  const spine = book ? W / 2 : 0;
  const w = book ? W / 2 : W;
  const g = curlGeometry(frame.corner, w, H, frame.bottom);

  ctx.clearRect(0, 0, W, H);

  // What lies still: the page being turned to underneath, and in a book the
  // left page of the spread being left, until the flap covers it.
  if (book) {
    drawSlice(ctx, frame, frame.from, 0, 0.5, 0, spine);
    drawSlice(ctx, frame, frame.to, 0.5, 0.5, spine, w);
  } else {
    drawSlice(ctx, frame, frame.to, 0, 1, 0, W);
  }

  ctx.save();
  ctx.translate(spine, 0);

  const flat = sheetPart(g, w, H, false);
  const flap = sheetPart(g, w, H, true);
  const n = g.foldNormal;
  const fp = g.foldPoint;
  const span = Math.max(24, w * 0.18);

  // Shadow the flap casts on the page it is uncovering.
  if (g.progress > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, H);
    ctx.clip();
    const shadow = ctx.createLinearGradient(fp.x, fp.y, fp.x + n.x * span, fp.y + n.y * span);
    shadow.addColorStop(0, "rgba(0,0,0,0.28)");
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
      bend.addColorStop(0, "rgba(0,0,0,0.14)");
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
      drawSlice(ctx, frame, frame.to, 0, 0.5, 0, w);
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
    const far = { x: fp.x + n.x * span * 2, y: fp.y + n.y * span * 2 };
    const curve = ctx.createLinearGradient(fp.x, fp.y, far.x, far.y);
    curve.addColorStop(0, "rgba(255,255,255,0.22)");
    curve.addColorStop(0.35, "rgba(255,255,255,0)");
    curve.addColorStop(1, "rgba(0,0,0,0.12)");
    ctx.fillStyle = curve;
    tracePolygon(ctx, flap);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
  return g.progress;
}
