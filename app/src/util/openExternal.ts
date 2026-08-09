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
    /*
     * Inside the shell, this is the only way out of it.
     *
     * `window.open` is not a fallback here — in a WebView it opens *another
     * WebView*, which is the in-app browser this function exists to avoid:
     * no logins, no history, no tabs, and the search result ends up inside
     * the annotation surface the search was a detour from. So a failure is
     * reported rather than papered over, because the fix is a capability the
     * app ships with and not something the reader can work around.
     *
     * The failure it was papering over was real: `opener:allow-open-url`
     * grants the command but the plugin also scope-checks the URL, and
     * without `opener:allow-default-urls` every call was refused — so every
     * Google tap took the fallback and opened in-app. Both are in
     * `capabilities/default.json` now.
     */
    await invoke("plugin:opener|open_url", { url });
    return;
  }
  // Plain browser build: a new tab is exactly right, and is what the user's
  // own browser gives them.
  window.open(url, "_blank", "noopener,noreferrer");
}
