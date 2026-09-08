import { describe, expect, it } from "vitest";

import { hexToRgb, hsvToHex, rgbToHsv, rgbToHex } from "./colorSlot";

describe("colorSlot", () => {
  it("round-trips hex through rgb", () => {
    expect(rgbToHex(hexToRgb("#ff8800")!)).toBe("#ff8800");
    expect(rgbToHex(hexToRgb("#abc")!)).toBe("#aabbcc");
  });

  it("keeps pure red through hsv", () => {
    const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
    expect(hsv.h).toBeCloseTo(0);
    expect(hsv.s).toBeCloseTo(1);
    expect(hsv.v).toBeCloseTo(1);
    expect(hsvToHex(hsv)).toBe("#ff0000");
  });

  it("rejects junk hex", () => {
    expect(hexToRgb("nope")).toBeNull();
    expect(hexToRgb("#12")).toBeNull();
  });
});
