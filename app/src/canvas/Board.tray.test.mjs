import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const board = readFileSync(new URL("./Board.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("vertical menu visibility", () => {
  it("keeps the complete menu available when hidden mode wakes", () => {
    // Main drawing chrome can stay hidden; the corner tray must still provide
    // its theme, page and agent controls, rather than restore only the eye.
    expect(board).toMatch(/const mountStackTools = chromeEnabled;/);
    expect(board).toMatch(/const chromeStackOpen = chromeShown\.eye;/);
  });

  it("lets the same fold control operate in visible, fade and hidden modes", () => {
    const start = board.indexOf('<div className={`lc-chrome-stack-tray');
    const end = board.indexOf('data-lc-explore-chrome', start);
    const tray = board.slice(start, end);
    expect(tray).toContain('trayFolded ? " is-folded" : ""');
    expect(tray).toContain('aria-expanded={!trayFolded}');
    expect(tray).toContain('setTrayFolded(value => !value)');
    expect(tray).not.toContain('chromeMode');
    expect(tray).not.toContain('agentOpen');
  });

  it("points collapse down and expand up along the bottom-anchored tray", () => {
    expect(board).toContain('trayFolded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"');
    expect(board).toContain('className="lc-chrome-stack-fold"');
    expect(board).toContain('lc-chrome-stack-fold-inner');
    expect(css).toContain('.lc-chrome-stack-tray.is-folded .lc-chrome-stack-fold');
    const start = css.indexOf('.lc-chrome-stack-tray.is-folded .lc-chrome-stack-fold {');
    const folded = css.slice(start, css.indexOf('}', start));
    expect(folded).toContain('grid-template-rows: 0fr');
    expect(css).toContain('transform: translateY(8px)');
  });

  it("keeps the agent tray under the open panel instead of punching through it", () => {
    expect(css).toContain('.lc-app-agent-open .lc-side {');
    const side = css.slice(css.indexOf('.lc-app-agent-open .lc-side {'), css.indexOf('}', css.indexOf('.lc-app-agent-open .lc-side {')));
    expect(side).toContain('z-index: 99');
    expect(css).not.toContain('.lc-board-chrome-slot:has(.lc-agent-tray-dot) { z-index: 100; }');
    expect(css).not.toContain('.lc-board-chrome-slot .lc-agent-tray-dot { pointer-events: auto !important; }');
    expect(css).not.toContain('.lc-map-chrome-stack:has(.lc-agent-tray-dot) { opacity: 1; }');
  });

  it("does not collapse the view tray to a close-dot overlay while chat is open", () => {
    expect(board).not.toContain('has-agent-open');
    expect(css).not.toContain('.lc-chrome-stack-tray.has-agent-open');
    expect(board).toContain('{chromeTraySleeps && (');
    expect(board).not.toContain('{chromeTraySleeps && !agentOpen && (');
  });
});
