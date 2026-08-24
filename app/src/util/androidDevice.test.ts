import { describe, expect, it } from "vitest";

import { isAndroidDevice } from "./androidDevice";

const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

describe("isAndroidDevice", () => {
  it("is true on an Android tablet UA", () => {
    expect(isAndroidDevice(ANDROID_TABLET)).toBe(true);
  });

  it("is false on a desktop UA", () => {
    expect(isAndroidDevice(DESKTOP)).toBe(false);
  });

  it("is not fooled by a desktop UA that merely mentions the word", () => {
    expect(isAndroidDevice("Mozilla/5.0 (X11; Linux x86_64) AndroidStudio/2024.1")).toBe(
      false,
    );
  });

  it("is false when there is no user agent", () => {
    expect(isAndroidDevice("")).toBe(false);
  });
});
