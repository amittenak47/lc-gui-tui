import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAN_FRICTION } from "../canvas/flickPredict";
import {
  loadPdfFlickHud,
  loadPdfFlickMomentum,
  pdfFlickFriction,
  pdfFlickTravelScale,
  PDF_FLICK_HUD_DEFAULT,
  PDF_FLICK_MOMENTUM_DEFAULT,
  PDF_FLICK_TRAVEL_AT_MAX,
  savePdfFlickHud,
  savePdfFlickMomentum,
} from "./pdfReadingPref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("pdfFlickHud", () => {
  it("defaults on, matching the always-visible pill", () => {
    expect(loadPdfFlickHud()).toBe(true);
    expect(PDF_FLICK_HUD_DEFAULT).toBe(true);
  });

  it("round-trips off", () => {
    savePdfFlickHud(false);
    expect(loadPdfFlickHud()).toBe(false);
  });
});

describe("pdfFlickFriction", () => {
  it("is shipping friction at the middle of the dial", () => {
    expect(pdfFlickFriction(PDF_FLICK_MOMENTUM_DEFAULT)).toBeCloseTo(PAN_FRICTION, 8);
    expect(loadPdfFlickMomentum()).toBe(PDF_FLICK_MOMENTUM_DEFAULT);
  });

  it("is a dead stop at 0 so inertia must not run", () => {
    expect(pdfFlickFriction(0)).toBe(0);
    expect(pdfFlickTravelScale(0)).toBe(0);
  });

  it("lowers friction as momentum goes up, so a flick coasts further", () => {
    expect(pdfFlickFriction(100)).toBeLessThan(pdfFlickFriction(50));
    expect(pdfFlickFriction(1)).toBeGreaterThan(pdfFlickFriction(50));
    expect(pdfFlickTravelScale(100)).toBeCloseTo(PDF_FLICK_TRAVEL_AT_MAX, 8);
    expect(pdfFlickTravelScale(50)).toBeCloseTo(1, 8);
  });

  it("clamps junk", () => {
    savePdfFlickMomentum(Number.NaN);
    expect(loadPdfFlickMomentum()).toBe(PDF_FLICK_MOMENTUM_DEFAULT);
    savePdfFlickMomentum(400);
    expect(loadPdfFlickMomentum()).toBe(100);
  });
});
