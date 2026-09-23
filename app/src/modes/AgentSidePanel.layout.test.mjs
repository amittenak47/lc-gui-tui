import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./AgentSidePanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("agent panel chrome", () => {
  it("shares the header's 1px edge instead of stacking a second top border", () => {
    const desktop = css.slice(
      css.indexOf("/* Header already paints the 1px seam"),
      css.indexOf("/* ---------------------------------------------------------------- header --- */"),
    );
    expect(desktop).toContain(".lc-app:not(.lc-mobile) .lc-side {");
    expect(desktop).toContain("border-top: none");
    const sideStart = css.indexOf("/* ------------------------------------------------------------ side panel --- */");
    const side = css.slice(sideStart, css.indexOf(".lc-app-agent-open .lc-side {", sideStart));
    expect(side).not.toContain("border-top:");
    const headerStart = css.indexOf("/* ---------------------------------------------------------------- header --- */");
    const header = css.slice(headerStart, css.indexOf(".lc-header button"));
    expect(header).toContain("border-bottom: 1px solid var(--chrome-edge)");
  });

  it("parks the conversation expand on the grab/fade strip, not over the transcript", () => {
    expect(panel).toContain('className="lc-agent-pane-expand-row lc-agent-pane-expand-panel"');
    const start = css.indexOf(".lc-agent-pane-expand-panel {");
    const row = css.slice(start, css.indexOf("}", start));
    expect(row).toContain("position: absolute");
    expect(row).toContain("top: 8px");
    expect(row).toContain("right: 12px");
    const desktop = css.slice(
      css.indexOf(".lc-app:not(.lc-mobile) .lc-agent-sheet-handle {"),
      css.indexOf(".lc-app:not(.lc-mobile) .lc-agent-sheet-handle .lc-agent-fold-bar {"),
    );
    expect(desktop).toContain("backdrop-filter: blur(6px)");
    expect(desktop).toContain("pointer-events: none");
    expect(desktop).not.toContain("display: none");
    expect(css).toContain("padding: 4px 12px 8px");
    expect(panel).toContain('aria-label={sessionsHidden ? "Show sessions" : "Hide sessions"}');
    expect(panel).toContain("lc-agent-panel-toggle");
    expect(panel).toContain("setSessionsHidden");
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
    expect(panel).toContain("const tip = statusTip(message)");
    expect(panel).toContain("aria-label={tip ?? undefined}");
    expect(panel).toContain("{running || completed ? <RunMark done={completed} /> : cancelled ? <StopIcon /> : <FailIcon />}");
    expect(panel).toContain("<MessageFlags message={message} />");
    expect(panel).not.toContain("MessageFlags message={message} header");
    expect(panel).not.toContain("lc-agent-turn-header-flags");
    expect(css).toContain(".lc-agent-turn-footnotes.is-failed");
    expect(css).toContain(".lc-agent-turn-failed .lc-agent-turn-body");
  });

  it("puts AGENT send flags under the turn with the same rule as YOU", () => {
    const flagsCall = panel.indexOf("<MessageFlags message={message} />");
    expect(flagsCall).toBeGreaterThan(panel.indexOf("lc-agent-proposal-saves"));
    expect(panel.indexOf("{message.role === \"assistant\" ? (")).toBe(-1);
    expect(css).toContain(".lc-agent-turn-flag-rule");
    expect(css).not.toContain(".lc-agent-turn-header-flags");
  });

  it("lets desktop drag-resize the agent column and hides the sash on mobile", () => {
    expect(panel).toContain("{!mobile && open ? <AgentPanelSash /> : null}");
    expect(css).toContain(".lc-agent-sash");
    expect(css).toContain(".lc-mobile .lc-agent-sash");
    const sash = css.slice(css.indexOf(".lc-mobile .lc-agent-sash {"), css.indexOf(".lc-app-agent-open .lc-side {"));
    expect(sash).toContain("display: none");
  });

  it("lets reasoning grow with the transcript instead of a nested scrollbar", () => {
    const body = css.slice(
      css.indexOf(".lc-agent-reasoning-body {"),
      css.indexOf(".lc-agent-drawing {"),
    );
    expect(body).toContain("overflow: visible");
    expect(body).toContain("white-space: normal");
    expect(body).not.toContain("max-height");
    expect(body).not.toContain("overflow: auto");
    expect(css).not.toContain(".lc-agent-reasoning-body::-webkit-scrollbar");
  });

  it("keeps table headers on one line and does not wrap Case letter-by-letter", () => {
    const md = css.slice(
      css.indexOf("/* Chat shares the document"),
      css.indexOf(".lc-agent-drawing-visibility"),
    );
    expect(md).toContain("overflow-wrap: break-word");
    expect(md).not.toContain("overflow-wrap: anywhere");
    expect(md).toContain(".lc-agent-markdown th {");
    expect(md).toContain("white-space: nowrap");
    expect(md).toContain(":is(th, td):first-child");
    expect(md).toContain("font-size: 1.1em");
  });

  it("drops the panel-chip well under chat code on dark palettes", () => {
    const md = css.slice(
      css.indexOf("/* Chat shares the document"),
      css.indexOf(".lc-agent-drawing-visibility"),
    );
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

  it("fades sibling actions after Copy, then dismisses the Copied chip", () => {
    expect(panel).toContain("COPY_ACK_MS = 700");
    expect(panel).toContain("setMenuFading(true)");
    expect(panel).toContain('data-copy=""');
    expect(css).toContain(".lc-agent-message-menu.is-copied > button:not([data-copy])");
    expect(css).toContain(".lc-agent-message-menu.is-closing");
    expect(css).toContain("lc-agent-menu-unpop");
  });
});
