import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeLinedPitch,
  completeLinedPitchPair,
  ensureLinedPitchPair,
  isLinedPaperMode,
  linedFirstRuleScene,
  linedPaperCssGap,
  linedPaperLabel,
  linedPaperScenePitch,
  linedPaperScreenPx,
  linedPitchFromAppState,
  linedPitchPairFromRuling,
  linedPitchPairFromZoom,
  linedPitchStateFromAppState,
  linedSitAboveScene,
  loadLinedPaperMode,
  nextLinedPaperMode,
  saveLinedPaperMode,
  LINED_PAPER_COLLEGE_SCREEN_PX,
  LINED_PAPER_SIT_ABOVE_FRAC,
  LINED_PAPER_WIDE_SCREEN_PX,
} from "./linedPaperPref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("lined paper cycle", () => {
  it("goes off → wide → college → off", () => {
    expect(nextLinedPaperMode("off")).toBe("wide");
    expect(nextLinedPaperMode("wide")).toBe("college");
    expect(nextLinedPaperMode("college")).toBe("off");
  });

  it("keeps the original 36px gap for wide, and a tighter college gap", () => {
    expect(linedPaperScreenPx("wide")).toBe(LINED_PAPER_WIDE_SCREEN_PX);
    expect(linedPaperScreenPx("college")).toBe(LINED_PAPER_COLLEGE_SCREEN_PX);
    expect(linedPaperScreenPx("college")).toBeLessThan(LINED_PAPER_WIDE_SCREEN_PX);
    expect(linedPaperScreenPx("off")).toBe(0);
  });

  it("names each mode for the button", () => {
    expect(linedPaperLabel("wide")).toBe("Wide lined paper");
    expect(linedPaperLabel("college")).toBe("College lined paper");
    expect(linedPaperLabel("off")).toBe("No lined paper");
  });

  it("rejects a stored value that is not a mode", () => {
    expect(isLinedPaperMode("wide")).toBe(true);
    expect(isLinedPaperMode("true")).toBe(false);
    expect(isLinedPaperMode(null)).toBe(false);
  });
});

describe("lined paper persist", () => {
  it("defaults to off, matching the old boolean", () => {
    expect(loadLinedPaperMode()).toBe("off");
  });

  it("round-trips every mode", () => {
    for (const mode of ["off", "wide", "college"] as const) {
      saveLinedPaperMode(mode);
      expect(loadLinedPaperMode()).toBe(mode);
    }
  });

  it("falls back when the stored value is not one we know", () => {
    localStorage.setItem("whiteboard.linedPaper.v1", "legal");
    expect(loadLinedPaperMode()).toBe("off");
  });
});

describe("lined paper scene pitch", () => {
  it("locks the gap to the zoom it was written at", () => {
    expect(linedPaperScenePitch("wide", 0.5)).toBe(LINED_PAPER_WIDE_SCREEN_PX / 0.5);
    expect(linedPaperCssGap(LINED_PAPER_WIDE_SCREEN_PX / 0.5, 0.25)).toBe(
      LINED_PAPER_WIDE_SCREEN_PX * 0.5,
    );
  });

  it("restores explicit pitches but leaves zoom-only files for the first fit", () => {
    expect(linedPitchFromAppState({ linedPitch: 72, zoom: 0.4 })).toBe(72);
    expect(linedPitchFromAppState({ zoom: 0.5 })).toBe(0);
    expect(linedPitchFromAppState({ zoom: { value: 0.5 } })).toBe(0);
    expect(linedPitchFromAppState({ zoom: 0.5 }, "college")).toBe(0);
    expect(linedPitchStateFromAppState({ zoom: { value: 1 } }).pair).toBeNull();
    expect(linedPitchFromAppState(null)).toBe(0);
  });

  it("captures 36px at the first width-fit and scales that paper in a split", () => {
    const pair = ensureLinedPitchPair(null, 0.2)!;
    expect(linedPaperCssGap(pair.wide, 0.2)).toBe(36);
    const splitPair = ensureLinedPitchPair(pair, 0.1)!;
    expect(splitPair).toEqual(pair);
    expect(linedPaperCssGap(splitPair.wide, 0.1)).toBe(18);
  });

  it("captures wide and college from the same write zoom, never equal", () => {
    const pair = linedPitchPairFromZoom(0.5);
    expect(pair).toEqual({
      wide: LINED_PAPER_WIDE_SCREEN_PX / 0.5,
      college: LINED_PAPER_COLLEGE_SCREEN_PX / 0.5,
    });
    expect(pair!.college).toBeLessThan(pair!.wide);
    expect(pair!.college / pair!.wide).toBeCloseTo(
      LINED_PAPER_COLLEGE_SCREEN_PX / LINED_PAPER_WIDE_SCREEN_PX,
    );
  });

  it("derives the other ruling from one source pitch", () => {
    const fromWide = linedPitchPairFromRuling(72, "wide");
    expect(fromWide?.wide).toBe(72);
    expect(fromWide?.college).toBeCloseTo(72 * (28 / 36));
    const fromCollege = linedPitchPairFromRuling(56, "college");
    expect(fromCollege?.college).toBe(56);
    expect(fromCollege?.wide).toBeCloseTo(56 * (36 / 28));
  });

  it("does not recapture a stored pair at a later zoom", () => {
    const written = linedPitchPairFromZoom(0.5)!;
    expect(ensureLinedPitchPair(written, 0.25)).toEqual(written);
    expect(completeLinedPitchPair({ wide: written.wide })?.college).toBeCloseTo(
      written.college,
    );
  });

  it("picks the source ruling's pitch, not a merged gap", () => {
    const pair = linedPitchPairFromZoom(0.5)!;
    expect(activeLinedPitch(pair, "wide")).toBe(pair.wide);
    expect(activeLinedPitch(pair, "college")).toBe(pair.college);
    expect(activeLinedPitch(pair, "college")).not.toBe(activeLinedPitch(pair, "wide"));
  });

  it("restores both pitches and the written-to ruling from the file", () => {
    const state = linedPitchStateFromAppState({
      linedPitchWide: 72,
      linedPitchCollege: 56,
      linedRule: "college",
      zoom: 0.2,
    });
    expect(state.pair).toEqual({ wide: 72, college: 56 });
    expect(state.rule).toBe("college");
  });

  it("sits college closer to its line than wide, because the gap is smaller", () => {
    const widePitch = LINED_PAPER_WIDE_SCREEN_PX / 0.5;
    const collegePitch = LINED_PAPER_COLLEGE_SCREEN_PX / 0.5;
    expect(linedSitAboveScene(collegePitch)).toBeLessThan(linedSitAboveScene(widePitch));
    expect(linedSitAboveScene(widePitch)).toBe(widePitch * LINED_PAPER_SIT_ABOVE_FRAC);
    expect(linedFirstRuleScene(10, widePitch, true)).toBeGreaterThan(
      linedFirstRuleScene(10, widePitch, false),
    );
    expect(
      linedFirstRuleScene(10, collegePitch, true) - linedFirstRuleScene(10, collegePitch, false),
    ).toBeCloseTo(linedSitAboveScene(collegePitch));
  });
});
