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
    const catalog = bar.indexOf('aria-label="Whiteboards and files"');
    expect(expand).toBeGreaterThan(-1);
    expect(annotations).toBeGreaterThan(expand);
    expect(catalog).toBeGreaterThan(annotations);
    const composer = panel.slice(panel.indexOf('className="lc-agent-composer"'));
    expect(composer.includes("lc-agent-pane-expand-row")).toBe(false);
    expect(composer.includes("Whiteboards & files")).toBe(false);
  });

  it("nests the composer bar as input adornments inside the ask field", () => {
    const field = panel.slice(panel.indexOf('className="lc-agent-composer-field"'));
    const textarea = field.indexOf("<textarea");
    const bar = field.indexOf('className="lc-agent-composer-bar"');
    expect(textarea).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(textarea);
    expect(panel).toContain("function PlusIcon");
    expect(css).toContain(".lc-agent-composer-field");
    expect(css).toContain(".lc-agent-composer-field:focus-within");
    expect(css).toContain(".lc-agent-composer-field .lc-flag");
    expect(css).toContain("color: var(--hint)");
    expect(css).not.toContain(".lc-agent-composer-field .lc-agent-send {\n  background: var(--accent)");
    const attach = css.slice(css.indexOf(".lc-agent-composer-bar .lc-agent-attach {"));
    expect(attach.slice(0, 180)).toContain("padding: 0");
    expect(attach.slice(0, 180)).toContain("line-height: 0");
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

  it("sizes YOU turns between a rem floor and 92%, hugging the text", () => {
    const user = css.slice(
      css.indexOf(".lc-agent-turn-user {"),
      css.indexOf("@keyframes lc-agent-bubble-enter"),
    );
    expect(user).toContain("width: fit-content");
    expect(user).toContain("min-width: 13rem");
    expect(user).toContain("max-width: 92%");
    expect(user).not.toContain("min-width: 72%");
  });

  it("rounds the outer turn and squares the thread chip with a footnote reply count", () => {
    const turn = css.slice(css.indexOf(".lc-agent-turn {"), css.indexOf(".lc-agent-turn-user {"));
    expect(turn).toContain("border-radius: 18px");
    const thread = css.slice(
      css.indexOf(".lc-agent-thread-open {"),
      css.indexOf(".lc-agent-thread-open:hover {"),
    );
    expect(thread).toContain("flex-direction: column");
    expect(thread).toContain("border-radius: 6px");
    expect(thread).not.toContain("999px");
    expect(css).toContain("align-self: flex-end");
    expect(panel).not.toContain("lc-agent-thread-open-chevron");
    expect(panel.indexOf("lc-agent-thread-open-peek")).toBeLessThan(
      panel.indexOf("lc-agent-thread-open-count", panel.indexOf("lc-agent-thread-open-peek")),
    );
  });

  it("marks a failed turn with an icon on the send-flags row instead of the word failed", () => {
    expect(panel).toContain("function FailIcon");
    expect(panel).toContain("lc-agent-turn-fail");
    expect(panel).toContain('aria-label="Failed"');
    expect(panel).toContain('message.requestState !== "failed"');
    expect(panel).toContain("header-flags");
    expect(css).toContain(".lc-agent-turn-header-flags.is-failed");
    expect(css).toContain(".lc-agent-turn-failed .lc-agent-turn-body");
  });

  it("drops the panel-chip well under chat code on dark palettes", () => {
    const md = css.slice(css.indexOf(".lc-agent-markdown {"), css.indexOf(".lc-agent-drawing-visibility"));
    expect(md).toContain("[data-theme=\"dark\"] .lc-agent-markdown pre");
    expect(md).toContain("[data-theme=\"dark\"] .lc-agent-markdown :not(pre) > code");
    expect(md).toContain("background: transparent");
    expect(md).toContain(".lc-agent-markdown pre code { background: none");
  });

  it("renders saved attachments as a span instead of a Tests bubble", () => {
    expect(panel).toContain("function isSavedAttachmentNotice");
    expect(panel).toContain("lc-artifact-save-notice");
    const cssFile = readFileSync(new URL("./artifacts.css", import.meta.url), "utf8");
    expect(cssFile).toContain(".lc-artifact-save-notice");
    expect(cssFile).toContain("align-self: flex-end");
    expect(cssFile).toContain("display: inline-flex");
  });

  it("parks per-turn save and attachment icons on the AGENT/YOU row", () => {
    expect(panel).toContain("lc-agent-turn-head");
    expect(panel).toContain("lc-agent-turn-tool");
    expect(panel).toContain("function SaveIcon");
    expect(panel).toContain("function PaperclipIcon");
    const start = css.indexOf(".lc-agent-turn-head {");
    const head = css.slice(start, css.indexOf(".lc-agent-turn-footnotes {"));
    expect(start).toBeGreaterThan(-1);
    expect(head).toContain("justify-content: space-between");
    expect(head).toContain(".lc-agent-turn-tool {");
    expect(head).toContain("width: 20px");
    expect(head).toContain("height: 20px");
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
