import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./AgentSidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("agent panel chrome", () => {
  it("parks the conversation expand at the panel's top-right with the composer control", () => {
    const start = css.indexOf(".lc-agent-chat > .lc-agent-pane-expand-row {");
    const row = css.slice(start, css.indexOf("}", start));
    expect(row).toContain("position: absolute");
    expect(row).toContain("top: 8px");
    expect(row).toContain("right: 12px");
    expect(css).toContain("padding: 4px 12px 8px");
    expect(css).toContain(".lc-agent-composer > .lc-agent-pane-expand-row");
  });

  it("grows the composer when the chat box is expanded", () => {
    expect(css).toContain(".lc-agent-chat.is-focus-composer .lc-agent-composer {\n  flex: 1 1 auto;");
    expect(css).toContain(".lc-agent-chat.is-focus-composer .lc-agent-composer textarea {\n  flex: 1 1 auto;");
    expect(panel).toContain("rows={4}");
    expect(css).toContain("--lc-agent-sheet: min(70vh, 640px)");
    expect(css).toContain("min-height: 72px");
  });
});
