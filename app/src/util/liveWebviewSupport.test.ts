import { describe, expect, it } from "vitest";

import { liveWebviewSupported } from "./liveWebviewSupport";

const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

describe("liveWebviewSupported", () => {
  it("says yes on a desktop WebView2", () => {
    expect(liveWebviewSupported(DESKTOP)).toBe(true);
  });

  it("says no on Android", () => {
    // wry's Android `set_bounds` and `set_visible` return Ok and do nothing, so
    // a live pane there cannot be placed or hidden — the two things it is.
    expect(liveWebviewSupported(ANDROID_TABLET)).toBe(false);
  });

  it("is not fooled by a desktop UA that merely mentions the word", () => {
    expect(
      liveWebviewSupported("Mozilla/5.0 (X11; Linux x86_64) AndroidStudio/2024.1"),
    ).toBe(true);
  });

  it("says no when there is no user agent to read", () => {
    // Better to withhold a feature than to offer one that fails into a banner.
    expect(liveWebviewSupported("")).toBe(false);
  });
});
