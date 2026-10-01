/**
 * The panel's refresh rate follows Settings → Match display.
 *
 * Android holds a WebView app at 60 Hz on a 90 Hz tablet unless the window
 * asks for more, so with Match display on the app asks for the panel's
 * fastest mode; off, it hands the choice back. Ink presents every vsync with
 * Match display on, so the two are one setting: run at what the panel can do.
 */
import { isAndroidDevice } from "./androidDevice";
import { INK_DISPLAY_HZ_EVENT, loadInkMatchDisplay } from "./inkDisplayHzPref";

async function request(high: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hz = await invoke<number>("set_display_refresh", { high });
    console.info(`[lc:display] ${high ? `asked for ${hz} Hz` : "refresh left to the system"}`);
  } catch {
    /* no shell, or an older one without the command: the panel keeps its rate */
  }
}

/** Apply the setting now and whenever it changes. Returns the cleanup. */
export function followMatchDisplay(): () => void {
  if (typeof window === "undefined" || !isAndroidDevice() || !("__TAURI_INTERNALS__" in window)) return () => {};
  let last: boolean | null = null;
  const apply = () => {
    const high = loadInkMatchDisplay();
    if (high === last) return;
    last = high;
    void request(high);
  };
  apply();
  window.addEventListener(INK_DISPLAY_HZ_EVENT, apply);
  return () => window.removeEventListener(INK_DISPLAY_HZ_EVENT, apply);
}
