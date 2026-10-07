import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyAppTheme, loadThemeId } from "./theme/appThemes";
import {
  migrateWhiteboardStorage,
} from "./util/storageMigration";
import { StorageUnavailableError } from "./util/idb";
import { hydrateBookMetadata } from "./util/localBookStore";
import "./styles.css";
import { debugLogEnabled, installDebugLog } from "./util/debugLog";

// Off unless switched on in Settings → Diagnostics; first, so the boot is in it too.
if (debugLogEnabled()) installDebugLog();

/*
 * The type documents are set in, fetched now rather than when first used.
 *
 * A face loads when text first needs it, which for a note is its first
 * layout: the note was laid out in fallback type, the faces arrived a moment
 * later, and every table, math span and line was laid out again — a second
 * whole-note layout in the middle of start-up. They are local files of a few
 * tens of KB, here long before any document is open.
 */
for (const face of [
  "1em DINish",
  "bold 1em DINish",
  "1em KaTeX_Main",
  "bold 1em KaTeX_Main",
  "italic 1em KaTeX_Main",
  "italic 1em KaTeX_Math",
  "1em KaTeX_Size1",
  "1em KaTeX_Size3",
]) {
  void document.fonts?.load(face).catch(() => {});
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

/**
 * Said out loud, because an upgrade can take a while.
 *
 * The migration copies the whole library between IndexedDB databases. It used
 * to run *before* `createRoot`, so a device with a lot of books spent that time
 * on a blank `#root` — which from the outside is the app failing to start,
 * right after an update, which is exactly when people expect it to. The copy
 * yields between batches, so this paints and keeps painting.
 *
 * Covers migration checks and metadata hydration before the app mounts, so
 * every launch can show it briefly even when no library import is needed.
 */
function UpdatingLibrary() {
  return (
    <div className="lc-server-gate-boot lc-library-boot" role="status" aria-live="polite">
      <p className="lc-boot-note">Updating your library…</p>
      <div className="lc-spinner" aria-hidden="true" />
    </div>
  );
}

applyAppTheme(loadThemeId());
const reactRoot = createRoot(root);

function mountApp() {
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

reactRoot.render(<UpdatingLibrary />);
void (async () => {
  try {
    await migrateWhiteboardStorage();
    await hydrateBookMetadata();
    // The theme key is one of the things that moves, so read it again.
    applyAppTheme(loadThemeId());
    mountApp();
  } catch (cause) {
    if(cause instanceof StorageUnavailableError) {
      // Ordinary localStorage saving stays available when IDB does not exist.
      await hydrateBookMetadata();
      mountApp();
      return;
    }
    reactRoot.render(
      <div className="lc-server-gate-boot" role="alert">
        <p className="lc-boot-note">The library could not be updated. Your saved copies have been kept.</p>
        <p>{cause instanceof Error?cause.message:String(cause)}</p>
        <button onClick={()=>window.location.reload()}>Retry</button>
      </div>,
    );
  }
})();
