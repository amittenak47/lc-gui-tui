import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./AgentSidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("agent panel chrome", () => {
  it("parks the conversation expand at the panel's top-right with the composer control", () => {
    expect(panel).toContain('className="lc-agent-pane-expand-row lc-agent-pane-expand-panel"');
    const start = css.indexOf(".lc-agent-pane-expand-panel {");
    const row = css.slice(start, css.indexOf("}", start));
    expect(row).toContain("position: absolute");
    expect(row).toContain("top: 8px");
    expect(row).toContain("right: 12px");
    expect(css).toContain("padding: 4px 12px 8px");
  });

  it("puts the chat-box expand on the composer bar before Annotations", () => {
    const bar = panel.slice(panel.indexOf('className="lc-agent-composer-mid"'));
    const expand = bar.indexOf('pane="composer"');
    const annotations = bar.indexOf('aria-label="Annotations"');
    expect(expand).toBeGreaterThan(-1);
    expect(annotations).toBeGreaterThan(expand);
    const composer = panel.slice(panel.indexOf('className="lc-agent-composer"'));
    expect(composer.includes("lc-agent-pane-expand-row")).toBe(false);
  });

  it("keeps photo immediately before Send", () => {
    const actions = panel.slice(panel.indexOf('className="lc-agent-composer-actions"'));
    expect(actions.indexOf('aria-label="Add Photo"')).toBeLessThan(actions.indexOf('aria-label="Send"'));
    const hand = css.slice(css.indexOf("[data-ui-handedness=\"left\"] .lc-agent-composer-actions {"));
    expect(hand.slice(0, 180)).not.toContain("row-reverse");
  });

  it("fades the top of the transcript instead of leaving a blank band", () => {
    expect(css).toContain(".lc-agent-messages-host::before");
    expect(css).toContain("backdrop-filter: blur(6px)");
    const messages = css.slice(
      css.indexOf(".lc-agent-messages {"),
      css.indexOf(".lc-agent-messages-anchor"),
    );
    expect(messages).not.toContain("mask-image:");
    expect(messages).not.toContain("justify-content: flex-end");
  });

  it("lets the transcript scroll without a visible scrollbar", () => {
    const messages = css.slice(
      css.indexOf(".lc-agent-messages {"),
      css.indexOf(".lc-agent-messages-anchor"),
    );
    expect(messages).toContain("overflow-y: auto");
    expect(messages).toContain("scrollbar-width: none");
    expect(css).toContain(".lc-agent-messages.lc-scroll-pane::-webkit-scrollbar");
    expect(panel).toContain("lc-agent-messages-anchor");
  });

  it("closes the annotations menu with the inverted pop", () => {
    expect(css).toContain("@keyframes lc-doc-unpop");
    expect(css).toContain(".lc-agent-scope-menu.is-closing");
    expect(panel).toContain("markMenuClosing");
    expect(panel).toContain("InkScribbleIcon");
    expect(panel).toContain("SendIcon");
    expect(css).toContain("width: 13.5rem");
  });

  it("grows the composer when the chat box is expanded", () => {
    expect(css).toMatch(/\.lc-agent-chat\.is-focus-composer \.lc-agent-composer \{\s*flex: 1 1 auto;/);
    expect(css).toMatch(/\.lc-agent-chat\.is-focus-composer \.lc-agent-composer textarea \{\s*flex: 1 1 auto;/);
    expect(panel).toContain("rows={10}");
    expect(css).toMatch(/\.lc-agent-composer textarea \{[\s\S]*?min-height: 10\.8rem/);
    expect(css).toMatch(/\.lc-mobile \.lc-agent-composer textarea \{[\s\S]*?min-height: 9\.1rem/);
  });

  it("keeps the open sheet above a clipped one-line composer", () => {
    const sheet = readFileSync(new URL("./useAgentSheet.ts", import.meta.url), "utf8");
    expect(sheet).toContain("AGENT_SHEET_MIN_PX = 400");
    expect(css).toContain("--lc-agent-sheet-min: 400px");
    expect(css).toContain("var(--lc-agent-sheet-min)");
  });
});
