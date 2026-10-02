import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyAppTheme, loadThemeId } from "./theme/appThemes";
import {
  migrateWhiteboardStorage,
  storageMigrationPending,
} from "./util/storageMigration";
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
 * Only for launches that actually have work to do: `storageMigrationPending`
 * is a synchronous marker read, so an ordinary launch never sees this flash
 * past on its way to the app.
 */
function UpdatingLibrary() {
  return (
    <div className="lc-server-gate-boot" role="status" aria-live="polite">
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

if (!storageMigrationPending()) {
  mountApp();
} else {
  reactRoot.render(<UpdatingLibrary />);
  void (async () => {
    await migrateWhiteboardStorage();
    // The theme key is one of the things that moves, so read it again.
    applyAppTheme(loadThemeId());
    mountApp();
  })();
}
