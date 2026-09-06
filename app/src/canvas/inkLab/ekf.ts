/**
 * 4-state EKF: x, y, vx, vy. One sample in, one filtered point out. O(1).
 * Process noise rises with jerk so corners stay sharp.
 */

export type EkfPoint = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
};

export type EkfFilter = {
  reset(x: number, y: number, t: number): void;
  step(x: number, y: number, t: number): EkfPoint;
  current(): EkfPoint | null;
};

const R_POS = 3.2 * 3.2;
const Q_BASE = 8;
const Q_JERK = 140;
const Q_JERK_CAP = 60;

export function createEkf(): EkfFilter {
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let t = 0;
  let lastImvx = 0;
  let lastImvy = 0;
  let ready = false;
  // Diagonal covariance: px, py, vx, vy
  let pX = 8;
  let pY = 8;
  let pVx = 200;
  let pVy = 200;

  const reset = (px: number, py: number, pt: number) => {
    x = px;
    y = py;
    vx = 0;
    vy = 0;
    t = pt;
    lastImvx = 0;
    lastImvy = 0;
    ready = true;
    pX = 8;
    pY = 8;
    pVx = 200;
    pVy = 200;
  };

  return {
    reset,
    current() {
      if (!ready) return null;
      return { x, y, vx, vy, t };
    },
    step(mx: number, my: number, mt: number) {
      if (!ready) {
        reset(mx, my, mt);
        return { x, y, vx, vy, t };
      }
      let dt = (mt - t) / 1000;
      if (!(dt > 1e-4)) dt = 1 / 120;
      if (dt > 0.08) dt = 0.08;

      const imvx = (mx - x) / dt;
      const imvy = (my - y) / dt;
      const predX = x + vx * dt;
      const predY = y + vy * dt;
      const innov = Math.hypot(mx - predX, my - predY);
      const jerk = Math.hypot(imvx - lastImvx, imvy - lastImvy) / dt;
      lastImvx = imvx;
      lastImvy = imvy;
      const q = Q_BASE + Q_JERK * Math.min(Math.max(jerk, innov / Math.max(dt, 1e-3)), Q_JERK_CAP);
      if (innov > 3) {
        pX += innov * innov;
        pY += innov * innov;
        pVx += innov * 40;
        pVy += innov * 40;
      }
      x = predX;
      y = predY;
      pX += q * dt * dt;
      pY += q * dt * dt;
      pVx += q;
      pVy += q;
      t = mt;

      const sx = pX + R_POS;
      const sy = pY + R_POS;
      const kx = pX / sx;
      const ky = pY / sy;
      const kvx = (pVx * dt) / sx;
      const kvy = (pVy * dt) / sy;
      const ix = mx - x;
      const iy = my - y;
      x += kx * ix;
      y += ky * iy;
      vx += kvx * ix;
      vy += kvy * iy;
      pX *= 1 - kx;
      pY *= 1 - ky;
      pVx *= 1 - kvx * dt;
      pVy *= 1 - kvy * dt;
      pX = Math.max(pX, 0.05);
      pY = Math.max(pY, 0.05);
      pVx = Math.max(pVx, 0.05);
      pVy = Math.max(pVy, 0.05);

      return { x, y, vx, vy, t };
    },
  };
}
