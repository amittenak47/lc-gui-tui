/**
 * Closed-form landing for the hand-pan coast.
 *
 * Board's inertia rAF is `vel *= exp(-PAN_FRICTION * dt)` until
 * `|vel| < PAN_REST_SPEED`. Same exponential, no second physics, no decode.
 * Paint must not read {@link predictFlickEndScrollY} to choose rest-2 / C.
 * Board may use it for the HUD and for 0.25 preload toward the guess.
 */

/** Hand-tool pan inertia — exponential friction per ms (coast after flick). */
export const PAN_FRICTION = 0.0045;
/** Minimum scroll speed (scene units/ms) to coast after a flick. */
export const PAN_FLICK_MIN = 0.035;
/** Stop coasting below this scroll speed. */
export const PAN_REST_SPEED = 0.02;

export function predictFlickDeltaY(
  velY: number,
  friction = PAN_FRICTION,
  restSpeed = PAN_REST_SPEED,
  flickMin = PAN_FLICK_MIN,
): number {
  if (!Number.isFinite(velY) || !(friction > 0)) return 0;
  if (Math.abs(velY) < flickMin) return 0;
  const sign = velY > 0 ? 1 : -1;
  return (velY - sign * restSpeed) / friction;
}

/** Unclamped end camera Y: live scroll plus remaining coast. */
export function predictFlickEndScrollY(
  scrollY: number,
  velY: number,
  friction = PAN_FRICTION,
  restSpeed = PAN_REST_SPEED,
  flickMin = PAN_FLICK_MIN,
): number {
  return scrollY + predictFlickDeltaY(velY, friction, restSpeed, flickMin);
}

/**
 * Discrete coast matching Board.step (no pan clamp). Tests the closed form
 * against the rAF loop, dt clamped 1..34 like the live stepper.
 */
export function simulateFlickCoastScrollY(
  scrollY: number,
  velY: number,
  friction = PAN_FRICTION,
  restSpeed = PAN_REST_SPEED,
  flickMin = PAN_FLICK_MIN,
  dt = 16,
): number {
  if (Math.abs(velY) < flickMin) return scrollY;
  let y = scrollY;
  let v = velY;
  const step = Math.min(34, Math.max(1, dt));
  for (let i = 0; i < 20000; i += 1) {
    y += v * step;
    v *= Math.exp(-friction * step);
    if (Math.abs(v) < restSpeed) return y;
  }
  return y;
}
