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
): void {
  ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]!;
    const b = spine[i]!;
    const col = a.rgb ?? rgb;
    ctx.fillStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
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
  }
  const head = spine[0];
  if (head) {
    const col = head.rgb ?? rgb;
    ctx.fillStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, head.r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tail = tip ?? spine[spine.length - 1];
  if (tail && tail !== head) {
    ctx.beginPath();
    ctx.arc(tail.x, tail.y, tail.r, 0, Math.PI * 2);
    ctx.fill();
  } else if (tail && spine.length < 2) {
    ctx.beginPath();
    ctx.arc(tail.x, tail.y, tail.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
