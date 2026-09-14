import { describe, expect, it } from "vitest";
import { hubReloadAppState, hubReloadDocumentElements } from "./boardHubReload";

describe("hub reload", () => {
  it.each(["off", "wide", "college"] as const)("restores %s ruling with the local camera", (mode) => {
    const live = { scrollX: 7, scrollY: -2200, zoom: 0.7, linedPaperMode: "wide" as const, linedPitch: 40 };
    const saved = { scrollX: 0, scrollY: 0, zoom: 2, linedPaperMode: mode, linedPitch: 32 };
    expect(hubReloadAppState(live, saved)).toMatchObject({ scrollX: 7, scrollY: -2200, zoom: 0.7, linedPaperMode: mode, linedPitch: 32 });
    expect(live.linedPitch).toBe(40);
  });
  it("does not infer legacy visibility or retain the previous notebook's pitch", () => {
    const result = hubReloadAppState({ scrollX: 0, scrollY: -400, zoom: 1, linedPitch: 60, linedPaperMode: "wide" },
      { scrollX: 0, scrollY: 0, zoom: 1 });
    expect(result.linedPaperMode).toBe("off");
    expect(result.linedPitch).toBeUndefined();
  });
  it("keeps a long measured markdown page scrollable after restoring a short saved frame", () => {
    const frame = { id: "lcmdink-0-frame", width: 800, height: 1100 };
    const mark = { id: "student-mark", height: 20 };
    const result = hubReloadDocumentElements([frame, mark], [{ ...frame, height: 18000 }]);
    expect(result[0]).toMatchObject({ height: 18000, width: 800 });
    expect(result[1]).toBe(mark);
    expect(frame.height).toBe(1100);
  });
  it("does not reuse measurements from a different document width", () => {
    const frame = { id: "lcmdink-0-frame", width: 600, height: 1100 };
    expect(hubReloadDocumentElements([frame], [{ ...frame, width: 800, height: 18000 }])[0]).toBe(frame);
  });
});
