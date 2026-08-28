import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyAppTheme, loadThemeId } from "./theme/appThemes";
import {
  migrateWhiteboardStorage,
  storageMigrationPending,
} from "./util/storageMigration";
import "./styles.css";

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
