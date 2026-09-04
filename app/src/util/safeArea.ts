/**
 * Measure system bar insets and publish them as `--lc-safe-*` on the root.
 *
 * Top inset often comes from `env(safe-area-inset-*)`. On Android WebView that
 * env is frequently 0 even when the status / caption bar is drawn on the
 * in-app header — the clock and battery sit on the tabs. Bottom has the same
 * hole; we already fill it from the visualViewport gap.
 *
 * Keyboard height must not share `--lc-safe-bottom`. The coach sheet used to
 * grow and pad by that gap while Android also panned the visual viewport, which
 * parked the sheet mid-screen. Nav stays on `--lc-safe-bottom`; keyboard is
 * `--lc-keyboard-inset` and only shifts `bottom`.
 */

import { isAndroidDevice } from "./androidDevice";

/** Gaps at or below this are home-indicator / nav; larger *may* be a keyboard. */
export const NAV_GAP_CAP_PX = 80;

/**
 * Soft keyboards are hundreds of pixels. A tablet taskbar or gesture bar is
 * often 48–120px — above {@link NAV_GAP_CAP_PX}, but lifting the sheet by that
 * amount leaves a hole of page under the composer. Only treat a gap as the
 * keyboard when it is clearly bigger than chrome.
 */
export const KEYBOARD_GAP_MIN_PX = 160;

export function splitBottomInsets(
  envBottom: number,
  visualGap: number,
): { safeBottom: number; keyboardInset: number } {
  const env = Math.max(0, envBottom);
  const gap = Math.max(0, visualGap);
  if (gap > Math.max(KEYBOARD_GAP_MIN_PX, env + NAV_GAP_CAP_PX)) {
    return { safeBottom: env, keyboardInset: gap };
  }
  return { safeBottom: Math.max(env, gap), keyboardInset: 0 };
}

/**
 * Typical Android status bar when CSS env and the native query are both silent.
 * Used only until `get_system_insets` answers (or if this APK has no command).
 */
export const ANDROID_STATUS_FALLBACK_PX = 32;

export type SystemInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/**
 * Pick the largest trustworthy top inset.
 *
 * Native is the status / caption overlap on the WebView. Env and visualViewport
 * catch iOS and the odd WebView that does publish CSS env. The Android fallback
 * only applies when nothing has measured yet — once native has answered, a 0
 * means the view is already below the bars, not "pad 32px anyway".
 */
export function combineTopInset(
  envTop: number,
  visualTop: number,
  nativeTop: number,
  opts?: { android?: boolean; nativeKnown?: boolean },
): number {
  const measured = Math.max(0, envTop, visualTop, nativeTop);
  if (measured > 0) return Math.round(measured);
  if (opts?.android && opts.nativeKnown !== true) return ANDROID_STATUS_FALLBACK_PX;
  return 0;
}

function readEnvInset(edge: "top" | "bottom" | "left" | "right"): number {
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:0;margin:0;border:0;";
  probe.style.setProperty(`padding-${edge}`, `env(safe-area-inset-${edge}, 0px)`);
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${edge}`)) || 0;
  probe.remove();
  return px;
}

function visualViewportBottomGap(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const gap = window.innerHeight - vv.offsetTop - vv.height;
  return gap > 0 ? Math.round(gap) : 0;
}

function visualViewportTopGap(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const gap = Math.round(vv.offsetTop);
  return gap > 0 ? gap : 0;
}

let nativeInsets: SystemInsets | null = null;
let nativeKnown = false;

function publishInsets(): void {
  const root = document.documentElement;
  const native = nativeInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const top = combineTopInset(readEnvInset("top"), visualViewportTopGap(), native.top, {
    android: isAndroidDevice(),
    nativeKnown,
  });
  const left = Math.max(readEnvInset("left"), native.left, 0);
  const right = Math.max(readEnvInset("right"), native.right, 0);
  const { safeBottom, keyboardInset } = splitBottomInsets(
    Math.max(readEnvInset("bottom"), native.bottom),
    visualViewportBottomGap(),
  );

  root.style.setProperty("--lc-safe-top", `${top}px`);
  root.style.setProperty("--lc-safe-left", `${Math.round(left)}px`);
  root.style.setProperty("--lc-safe-right", `${Math.round(right)}px`);
  root.style.setProperty("--lc-safe-bottom", `${safeBottom}px`);
  root.style.setProperty("--lc-keyboard-inset", `${keyboardInset}px`);
}

/** Keep `--lc-safe-*` in sync with rotation, keyboard, and Android nav bar changes. */
export function installSafeAreaInsets(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let cancelled = false;
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(publishInsets);
  };

  const pullNativeInsets = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const got = await invoke<SystemInsets>("get_system_insets", {
        density: window.devicePixelRatio || 1,
      });
      if (cancelled || !got || typeof got.top !== "number") return;
      nativeInsets = {
        top: Math.max(0, got.top),
        right: Math.max(0, got.right),
        bottom: Math.max(0, got.bottom),
        left: Math.max(0, got.left),
      };
      nativeKnown = true;
      publishInsets();
    } catch {
      /* desktop browser, or an APK built before get_system_insets */
    }
  };

  schedule();
  void pullNativeInsets();
  window.addEventListener("resize", schedule);
  window.addEventListener("resize", pullNativeInsets);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);

  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("resize", pullNativeInsets);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    nativeInsets = null;
    nativeKnown = false;
    const root = document.documentElement;
    root.style.removeProperty("--lc-safe-top");
    root.style.removeProperty("--lc-safe-left");
    root.style.removeProperty("--lc-safe-right");
    root.style.removeProperty("--lc-safe-bottom");
    root.style.removeProperty("--lc-keyboard-inset");
  };
}
