/**
 * Android WebView / Chrome on Android — not a resized desktop window, not a
 * coarse-pointer laptop, not a UA that merely contains the substring
 * (Android Studio).
 *
 * Viewport `.lc-mobile` is the wrong key for quote-select: a narrow desktop
 * window would lose native drag-select, and a wide tablet in landscape can
 * miss a width-only query. Handled devices always take the sheet (see `mobile.ts`).
 */

export function isAndroidDevice(userAgent?: string): boolean {
  const ua =
    userAgent ??
    (typeof navigator === "undefined" ? "" : navigator.userAgent || "");
  return /\bandroid\b/i.test(ua);
}
