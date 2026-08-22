/**
 * Which surface holds a live page here.
 *
 * The interesting assertion is the one that changed: Android is no longer a
 * no. It was a no because wry's `set_bounds` and `set_visible` do nothing
 * there, which is a fact about wry and not about the platform — and the
 * `livewebview` plugin is the platform's own answer. What stays a no is a
 * plain browser tab, where there is no native surface under either name.
 */
import { describe, expect, it } from "vitest";

import { liveWebviewSupported, liveWebviewTransport } from "./liveWebviewSupport";

const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const IN_SHELL = true;
const IN_BROWSER = false;

describe("liveWebviewTransport", () => {
  it("uses wry's child webview on the desktop shell", () => {
    expect(liveWebviewTransport(DESKTOP, IN_SHELL)).toBe("wry");
  });

  it("uses the Android plugin on a tablet", () => {
    expect(liveWebviewTransport(ANDROID_TABLET, IN_SHELL)).toBe("android");
  });

  it("has nothing to offer outside the shell", () => {
    // `npm run dev` in a browser tab: no native surface under any name, and a
    // `new Webview` there only throws further down.
    expect(liveWebviewTransport(DESKTOP, IN_BROWSER)).toBe("none");
    expect(liveWebviewTransport(ANDROID_TABLET, IN_BROWSER)).toBe("none");
  });

  it("is not fooled by a desktop UA that merely mentions the word", () => {
    expect(
      liveWebviewTransport("Mozilla/5.0 (X11; Linux x86_64) AndroidStudio/2024.1", IN_SHELL),
    ).toBe("wry");
  });

  it("offers nothing when there is no user agent to read", () => {
    // Better to withhold a feature than to offer one that fails into a banner.
    expect(liveWebviewTransport("", IN_SHELL)).toBe("none");
  });
});

describe("liveWebviewSupported", () => {
  it("says yes wherever a transport answers, Android included", () => {
    expect(liveWebviewSupported(DESKTOP, IN_SHELL)).toBe(true);
    expect(liveWebviewSupported(ANDROID_TABLET, IN_SHELL)).toBe(true);
  });

  it("says no in a plain browser", () => {
    expect(liveWebviewSupported(DESKTOP, IN_BROWSER)).toBe(false);
  });
});
