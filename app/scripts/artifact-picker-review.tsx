// Isolated visual fixture, mounted only by artifact-integration.html.
import "../src/styles.css";
import { createRoot } from "react-dom/client";
import { ArtifactPicker } from "../src/modes/ArtifactPicker";
import { ShellContext, type ShellValue } from "../src/shellContext";
import { applyAppTheme } from "../src/theme/appThemes";

let root: ReturnType<typeof createRoot> | undefined;
export function showPicker() {
  if (!root) {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  }
  applyAppTheme("graphite");
  document.body.style.background = "#171b22";
  root.render(<ShellContext.Provider value={{ themeId: "graphite", client: {} } as ShellValue}>
    <ArtifactPicker parent={{ kind: "problem", id: "phase3-test/1" }} associations={[]}
      pageChoices={[{ id: "scratch", title: "Scratch", kind: "markdown", pages: 4 }, { id: "code", title: "Code", kind: "code", pages: 2 }]}
      onAttach={() => {}} onOpen={() => {}} onClose={() => root?.render(null)} />
  </ShellContext.Provider>);
}
