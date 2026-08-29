import { describe, expect, it } from "vitest";

import { planAutosaveTick } from "./autosaveSchedule";

const base = { hasProblem: true, showing: true, autosaveMs: 3000, wasScheduled: false };

describe("planAutosaveTick", () => {
  it("schedules at the saved interval for a pane on screen", () => {
    expect(planAutosaveTick(base)).toEqual({ periodMs: 3000, finalPass: false });
  });

  it("still watches once a second when autosave is Off", () => {
    expect(planAutosaveTick({ ...base, autosaveMs: 0 })).toEqual({
      periodMs: 1000,
      finalPass: false,
    });
    expect(planAutosaveTick({ ...base, autosaveMs: -1 }).periodMs).toBe(1000);
  });

  it("does not fingerprint a parked pad, autosave Off or On", () => {
    expect(planAutosaveTick({ ...base, showing: false, autosaveMs: 0 }).periodMs).toBeNull();
    expect(planAutosaveTick({ ...base, showing: false }).periodMs).toBeNull();
  });

  it("keeps the tick on the visible inactive half of a split", () => {
    // `showing` is the whole question — the split partner is not active and
    // its dirty dot still has to move.
    expect(planAutosaveTick({ ...base, showing: true }).periodMs).toBe(3000);
  });

  it("owes one final pass on the way out, so parking cannot lose a write", () => {
    const running = planAutosaveTick(base);
    expect(running.periodMs).toBe(3000);
    const parked = planAutosaveTick({ ...base, showing: false, wasScheduled: true });
    expect(parked).toEqual({ periodMs: null, finalPass: true });
  });

  it("does not pass again while it stays parked", () => {
    expect(
      planAutosaveTick({ ...base, showing: false, wasScheduled: false }).finalPass,
    ).toBe(false);
  });

  it("mounting already parked is not a final pass", () => {
    expect(planAutosaveTick({ ...base, showing: false })).toEqual({
      periodMs: null,
      finalPass: false,
    });
  });

  it("does nothing at all without a pad, even coming off screen", () => {
    expect(
      planAutosaveTick({ ...base, hasProblem: false, showing: false, wasScheduled: true }),
    ).toEqual({ periodMs: null, finalPass: false });
  });
});
