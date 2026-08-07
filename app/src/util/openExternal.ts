/**
 * Hand a URL to whatever browser the device already uses.
 *
 * Reading is a thing people do with tabs open. An in-app webview would be a
 * worse browser with none of their logins and no history, and it would put the
 * search result inside the annotation surface the search was a detour from —
 * so a footnote's Google Search leaves the app entirely.
 *
 * The Tauri opener plugin is the real path (it reaches an Android intent as
 * well as a desktop shell). `window.open` is the fallback for the plain browser
 * build, where it is already the right answer.
 */

let invokeLoader: Promise<((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null> | null =
  null;

function loadInvoke() {
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
      .catch(() => null);
  }
  return invokeLoader;
}

/** Only ever hand out links we built — never a `javascript:` from a document. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) throw new Error(`refusing to open ${url}`);
  const invoke = await loadInvoke();
  if (invoke) {
    try {
      await invoke("plugin:opener|open_url", { url });
      return;
    } catch {
      // An older shell without the plugin, or a denied capability — the window
      // fallback below is still better than swallowing the tap.
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
