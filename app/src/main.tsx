import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyAppTheme, loadThemeId } from "./theme/appThemes";
import { migrateWhiteboardStorage } from "./util/storageMigration";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

void (async () => {
  await migrateWhiteboardStorage();
  applyAppTheme(loadThemeId());
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
