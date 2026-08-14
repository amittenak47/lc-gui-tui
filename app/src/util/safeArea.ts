/**
 * Measure system bar insets and publish them as `--lc-safe-*` on the root.
 *
 * Top inset often comes from `env(safe-area-inset-*)`. Bottom is frequently 0 in
 * Android WebView even when the gesture bar covers the app — we measure the
 * visualViewport gap and pad `.lc-app` once at the shell level.
 *
 * Keyboard height must not share `--lc-safe-bottom`. The coach sheet used to
 * grow and pad by that gap while Android also panned the visual viewport, which
 * parked the sheet mid-screen. Nav stays on `--lc-safe-bottom`; keyboard is
 * `--lc-keyboard-inset` and only shifts `bottom`.
 */

import { isMobileViewport } from "./mobile";

/** Gaps at or below this are home-indicator / nav; larger is the soft keyboard. */
export const NAV_GAP_CAP_PX = 80;

export function splitBottomInsets(
  envBottom: number,
  visualGap: number,
): { safeBottom: number; keyboardInset: number } {
  const env = Math.max(0, envBottom);
  const gap = Math.max(0, visualGap);
  if (gap > NAV_GAP_CAP_PX) {
    return { safeBottom: env, keyboardInset: gap };
  }
  return { safeBottom: Math.max(env, gap), keyboardInset: 0 };
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

function publishInsets(): void {
  const root = document.documentElement;
  const top = Math.max(readEnvInset("top"), 0);
  const left = Math.max(readEnvInset("left"), 0);
  const right = Math.max(readEnvInset("right"), 0);
  const { safeBottom, keyboardInset } = splitBottomInsets(
    readEnvInset("bottom"),
    visualViewportBottomGap(),
  );

  root.style.setProperty("--lc-safe-top", `${top}px`);
  root.style.setProperty("--lc-safe-left", `${left}px`);
  root.style.setProperty("--lc-safe-right", `${right}px`);
  root.style.setProperty("--lc-safe-bottom", `${safeBottom}px`);
  root.style.setProperty("--lc-keyboard-inset", `${keyboardInset}px`);
}

/** Keep `--lc-safe-*` in sync with rotation, keyboard, and Android nav bar changes. */
export function installSafeAreaInsets(): () => void {
  if (typeof window === "undefined" || !isMobileViewport()) {
    return () => {};
  }

  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(publishInsets);
  };

  schedule();
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    const root = document.documentElement;
    root.style.removeProperty("--lc-safe-top");
    root.style.removeProperty("--lc-safe-left");
    root.style.removeProperty("--lc-safe-right");
    root.style.removeProperty("--lc-safe-bottom");
    root.style.removeProperty("--lc-keyboard-inset");
  };
}
