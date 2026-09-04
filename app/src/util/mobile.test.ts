import { describe, expect, it } from "vitest";

import { isHandheldDevice, shouldUseMobileChrome } from "./mobile";

const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

describe("isHandheldDevice", () => {
  it("is true on an Android tablet", () => {
    expect(isHandheldDevice(ANDROID_TABLET, 0)).toBe(true);
  });

  it("is true on an iPhone", () => {
    expect(isHandheldDevice(IPHONE, 5)).toBe(true);
  });

  it("treats iPadOS desktop UA with a touch surface as a tablet", () => {
    expect(isHandheldDevice(IPADOS_DESKTOP_UA, 5)).toBe(true);
  });

  it("does not treat a Windows desktop as a tablet, even with a touchscreen", () => {
    expect(isHandheldDevice(WINDOWS, 10)).toBe(false);
  });
});

describe("shouldUseMobileChrome", () => {
  it("uses the sheet on a handheld even when the window is wide", () => {
    expect(shouldUseMobileChrome({ handheld: true, viewportNarrow: false })).toBe(true);
  });

  it("uses the side panel on a wide desktop window", () => {
    expect(shouldUseMobileChrome({ handheld: false, viewportNarrow: false })).toBe(false);
  });

  it("uses the sheet on a phone-narrow desktop window", () => {
    expect(shouldUseMobileChrome({ handheld: false, viewportNarrow: true })).toBe(true);
  });
});
