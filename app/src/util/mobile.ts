/**
 * One definition of "this is a phone or a tablet", shared by the layout and the
 * CSS.
 *
 * A coarse pointer is not enough — a Windows laptop with a touchscreen is still
 * a desktop, and that is how the coach used to open as a bottom sheet on a
 * wide window. Phones and tablets (Android / iOS, including iPadOS's Mac UA)
 * always get the sheet. A desktop window only gets it when it is phone-narrow.
 *
 * The same answer is what `lc-mobile` on the app root means, so styles and
 * behaviour can never disagree.
 */

import { useEffect, useState } from "react";

import { isAndroidDevice } from "./androidDevice";

/** Phone-narrow desktop windows. Handhelds ignore this and always use the sheet. */
export const MOBILE_MEDIA_QUERY = "(max-width: 900px)";

export function isHandheldDevice(
  userAgent?: string,
  maxTouchPoints?: number,
): boolean {
  const ua =
    userAgent ??
    (typeof navigator === "undefined" ? "" : navigator.userAgent || "");
  const points =
    maxTouchPoints ??
    (typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0);
  if (isAndroidDevice(ua)) return true;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  /* iPadOS 13+ reports as Macintosh. */
  if (points > 1 && /macintosh/i.test(ua)) return true;
  return false;
}

export function shouldUseMobileChrome(opts: {
  handheld: boolean;
  viewportNarrow: boolean;
}): boolean {
  return opts.handheld || opts.viewportNarrow;
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  const narrow =
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  return shouldUseMobileChrome({
    handheld: isHandheldDevice(),
    viewportNarrow: Boolean(narrow),
  });
}

/** Re-renders when the viewport crosses the mobile threshold. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(isMobileViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => setMobile(isMobileViewport());
    onChange();
    // Safari < 14 only has the deprecated listener API.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return mobile;
}
