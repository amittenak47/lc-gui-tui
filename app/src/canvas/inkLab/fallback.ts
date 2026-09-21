/**
 * Canvas 2D mitered strip. Shared vertices. Round caps only at the true head
 * and tail. One tip disc while held. No arc() at interior joins.
 */

import type { SpineDot } from "./instance";

export type FallbackPainter = {
  canvas: HTMLCanvasElement;
  resize(w: number, h: number): void;
  beginStroke(): void;
  appendHop(a: SpineDot, b: SpineDot, rgb: readonly [number, number, number]): void;
  clearLive(): void;
  blit(ctx: CanvasRenderingContext2D): void;
  destroy(): void;
};

function fillQuad(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.lineTo(dx, dy);
  ctx.closePath();
  ctx.fill();
}

export function createFallbackPainter(
  peer: (w: number, h: number) => HTMLCanvasElement | null,
  w: number,
  h: number,
): FallbackPainter | null {
  const canvas = peer(Math.max(1, w), Math.max(1, h));
  if (!canvas) return null;
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let cappedHead = false;

  const resize = (nw: number, nh: number) => {
    const width = Math.max(1, nw);
    const height = Math.max(1, nh);
    if (canvas.width === width && canvas.height === height) return;
    const prev = peer(canvas.width, canvas.height);
    if (prev) {
      prev.width = canvas.width;
      prev.height = canvas.height;
      const pctx = prev.getContext("2d");
      pctx?.drawImage(canvas, 0, 0);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(prev, 0, 0);
    } else {
      canvas.width = width;
      canvas.height = height;
    }
  };

  return {
    canvas,
    resize,
    beginStroke() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cappedHead = false;
    },
    appendHop(a, b, rgb) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      if (len < 1e-4) {
        if (!cappedHead) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
          ctx.fill();
          cappedHead = true;
        }
        return;
      }
      const nx = -dy / len;
      const ny = dx / len;
      fillQuad(
        ctx,
        a.x + nx * a.r,
        a.y + ny * a.r,
        b.x + nx * b.r,
        b.y + ny * b.r,
        b.x - nx * b.r,
        b.y - ny * b.r,
        a.x - nx * a.r,
        a.y - ny * a.r,
      );
      if (!cappedHead) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
        cappedHead = true;
      }
    },
    clearLive() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cappedHead = false;
    },
    blit(target) {
      target.drawImage(canvas, 0, 0);
    },
    destroy() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

export function fillMiterStroke(
  ctx: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
  rgb: readonly [number, number, number],
  opts?: { capHead?: boolean; capEnd?: boolean; from?: number; to?: number },
): void {
  const from = Math.max(0, opts?.from ?? 0);
  const to = Math.min(spine.length - 1, opts?.to ?? spine.length - 1);
  if (to < from) return;
  // Shared, bounded miter vertices: adjacent quads meet without interior discs.
  // Include the neighbours outside a requested span so frozen/tail joins agree.
  const edge = (i: number): [number, number] => {
    const p = spine[i]!;
    const before = spine[Math.max(0, i - 1)]!;
    const after = spine[Math.min(spine.length - 1, i + 1)]!;
    const ax = p.x - before.x, ay = p.y - before.y;
    const bx = after.x - p.x, by = after.y - p.y;
    const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
    const nx = bl > 1e-4 ? -by / bl : al > 1e-4 ? -ay / al : 0;
    const ny = bl > 1e-4 ? bx / bl : al > 1e-4 ? ax / al : 1;
    if (al < 1e-4 || bl < 1e-4) return [nx * p.r, ny * p.r];
    const mx = -ay / al + nx, my = ax / al + ny;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-4) return [nx * p.r, ny * p.r];
    const ux = mx / ml, uy = my / ml;
    const radius = Math.min(p.r * 2, p.r / Math.max(0.5, ux * nx + uy * ny));
    return [ux * radius, uy * radius];
  };
  let style = "";
  let alpha = -1;
  let pending = false;
  const use = (p: SpineDot) => {
    const col = p.rgb ?? rgb;
    const next = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
    const a = p.a ?? 1;
    if (next !== style || a !== alpha) {
      if (pending) ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = style = next;
      ctx.globalAlpha = alpha = a;
      pending = false;
    }
    pending = true;
  };
  const cap = (p: SpineDot) => {
    use(p);
    ctx.moveTo(p.x + p.r, p.y);
    // Same winding as the strip, so a cap overlaps rather than cuts it out.
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2, true);
    ctx.closePath();
  };
  for (let i = from; i < to; i++) {
    const a = spine[i]!, b = spine[i + 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-4) continue;
    use(a);
    let [ax, ay] = edge(i), [bx, by] = edge(i + 1);
    const nx = a.y - b.y, ny = b.x - a.x;
    // A retrace reverses the geometric normal. Orient both ends to this
    // hop, otherwise the quad becomes a bow-tie with a transparent centre.
    if (ax * nx + ay * ny < 0) { ax = -ax; ay = -ay; }
    if (bx * nx + by * ny < 0) { bx = -bx; by = -by; }
    ctx.moveTo(a.x + ax, a.y + ay);
    ctx.lineTo(b.x + bx, b.y + by);
    ctx.lineTo(b.x - bx, b.y - by);
    ctx.lineTo(a.x - ax, a.y - ay);
    ctx.closePath();
  }
  const head = spine[0];
  const tail = tip ?? spine[spine.length - 1];
  const capHead = opts?.capHead !== false && from === 0;
  if (head && capHead) cap(head);
  if (tail && opts?.capEnd !== false && to === spine.length - 1) {
    if (!head || !capHead || Math.hypot(tail.x - head.x, tail.y - head.y) > 1e-4 ||
        Math.abs(tail.r - head.r) > 1e-4) cap(tail);
  }
  if (pending) ctx.fill();
  ctx.globalAlpha = 1;
}
