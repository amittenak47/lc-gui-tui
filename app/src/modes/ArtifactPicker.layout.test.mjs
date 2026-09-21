import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const picker = readFileSync(new URL("./ArtifactPicker.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./artifacts.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("attachment picker chrome", () => {
  it("uses the Settings backdrop and leave animation instead of a full-bleed sheet", () => {
    expect(picker).toContain("createPortal");
    expect(picker).toContain("lc-settings-backdrop");
    expect(picker).toContain("lc-server-gate-enter");
    expect(picker).toContain("lc-leave-dialog-exit");
    expect(picker).toContain("lc-artifact-picker-modal");
    expect(css).toContain("width: min(420px, 100%)");
    expect(css).toContain("max-height: min(70vh, 480px)");
    expect(css).toContain("animation: lc-board-in");
    expect(css).not.toContain("inset: 12vh");
    expect(styles).toContain(".lc-artifact-picker-modal");
  });

  it("puts kind chips and create inside the title field as input adornments", () => {
    expect(picker).toContain("lc-artifact-picker-compose");
    expect(picker).toContain("lc-artifact-picker-adorn-start");
    expect(picker).toContain("lc-artifact-picker-adorn");
    expect(picker).toContain("ArtifactKindIcon");
    expect(picker).toContain("artifactKindLabel");
    expect(picker).not.toContain("function BoardIcon");
    expect(picker).not.toContain("function NoteIcon");
    expect(picker).not.toContain("function CodeIcon");
    expect(picker).toContain("function FootnotesIcon");
    expect(picker).toContain('aria-label="Create attachment"');
    expect(picker).toContain("CreateIcon");
    expect(picker).toContain('aria-label="Footnotes"');
    expect(picker).toContain('aria-label="Search catalog or name a new attachment"');
    expect(picker).not.toContain('placeholder="Search catalog"');
    expect(picker).not.toContain("Title (optional)");
    expect(picker).not.toContain('aria-label="New attachment title"');
    expect(picker).not.toContain("Marks for the next question");
    expect(css).toContain(".lc-artifact-picker-compose");
    expect(css).toContain(".lc-artifact-picker-submit");
    expect(css).toContain(".lc-artifact-picker-submit:hover:not(:disabled)");
    expect(css).toContain("box-shadow: inset 0 -2px 0 currentColor");
    expect(css).toContain("button.lc-artifact-picker-adorn:not([data-filling]) .lc-hold-reveal-fill");
    expect(css).toContain("visibility: hidden");
    expect(picker).toContain("HoldButton");
    expect(picker).toContain("is-filter");
    expect(picker).toContain("tap to create, hold to filter");
    expect(picker).toContain("ConfirmDialog");
    expect(picker).toContain("LibraryPadlock");
    expect(picker).toContain("useLibraryDeleteArm");
    expect(picker).not.toContain("window.confirm");
    expect(picker).not.toContain("window.alert");
    expect(picker).not.toContain("Trash on this device");
    expect(css).toContain("button.lc-artifact-picker-adorn");
    expect(css).toContain("color: var(--hint)");
    expect(css).toContain("border: 1px solid var(--chrome-edge)");
    expect(css).toContain("background: var(--bg)");
    expect(css).toContain("line-height: 0");
    expect(css).not.toContain("var(--border");
    expect(css).not.toContain(".lc-artifact-picker button { min-height: 40px }");
  });
});

describe("Board / Note / Code editor chrome", () => {
  it("uses themed overlay chrome instead of the dark 40px sheet", () => {
    const workspace = readFileSync(new URL("./ArtifactWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("lc-artifact-chrome");
    expect(workspace).toContain("lc-artifact-editor-backdrop");
    expect(workspace).toContain("data-artifact-kind");
    expect(workspace).toContain("ArtifactKindIcon");
    expect(workspace).toContain("kindName} attachment");
    expect(workspace).toContain("lc-artifact-title");
    expect(workspace).not.toContain("lc-artifact-actions");
    expect(workspace).not.toContain(">Save a copy<");
    expect(workspace).not.toContain(">Previous page<");
    expect(css).toContain(".lc-artifact-chrome");
    expect(css).toContain("background: var(--bg)");
    expect(css).toContain("background: var(--panel)");
    expect(css).not.toContain("#252a32");
    expect(css).not.toContain("#7d899b");
    expect(css).not.toContain("min-height: 40px");
    expect(css).toContain(".lc-artifact-chrome button");
    expect(css).toContain("min-height: 28px");
  });
});
