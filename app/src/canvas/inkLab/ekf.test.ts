import { describe, expect, it } from "vitest";

import { createEkf } from "./ekf";

describe("EKF", () => {
  it("follows one hop", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    const out = ekf.step(10, 0, 16);
    expect(out.x).toBeGreaterThan(4);
    expect(Math.abs(out.y)).toBeLessThan(1);
  });

  it("does not drift on a hold", () => {
    const ekf = createEkf();
    ekf.reset(40, 80, 0);
    let last = ekf.current()!;
    for (let i = 1; i <= 24; i++) {
      last = ekf.step(40.1, 80.05, i * 8);
    }
    expect(Math.hypot(last.x - 40, last.y - 80)).toBeLessThan(1.5);
  });

  it("turns a corner instead of rounding it away", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    for (let i = 1; i <= 8; i++) ekf.step(i * 8, 0, i * 8);
    const after = ekf.step(64, 24, 9 * 8);
    expect(after.y).toBeGreaterThan(4);
    expect(after.x).toBeGreaterThan(50);
  });
});
