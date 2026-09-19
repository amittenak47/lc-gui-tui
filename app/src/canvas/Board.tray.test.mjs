import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const board = readFileSync(new URL("./Board.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("vertical menu visibility", () => {
  it("keeps the complete menu available when hidden mode wakes", () => {
    // Main drawing chrome can stay hidden; the corner tray must still provide
    // its theme, page and agent controls, rather than restore only the eye.
    expect(board).toMatch(/const mountStackTools = chromeEnabled;/);
    expect(board).toMatch(/const chromeStackOpen = agentOpen \|\| chromeShown\.eye;/);
  });

  it("lets the same fold control operate in visible, fade and hidden modes", () => {
    const start = board.indexOf('<div className={`lc-chrome-stack-tray');
    const end = board.indexOf('data-lc-explore-chrome', start);
    const tray = board.slice(start, end);
    expect(tray).toContain('trayFolded && !agentOpen');
    expect(tray).toContain('aria-expanded={!trayFolded}');
    expect(tray).toContain('setTrayFolded(value => !value)');
    expect(tray).not.toContain('chromeMode');
  });

  it("points collapse down and expand up along the bottom-anchored tray", () => {
    expect(board).toContain('trayFolded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"');
    const start = css.indexOf('.lc-map-chrome-stack .lc-chrome-stack-tray.is-folded > :not(.lc-tray-fold) {');
    const folded = css.slice(start, css.indexOf('}', start));
    expect(folded).toContain('translateY(10px) scaleY(0)');
    expect(folded).toContain('visibility: hidden');
    expect(folded).toContain('pointer-events: none');
  });

  it("raises the dot's stacking ancestor above the sheet, but below open dialogs", () => {
    expect(css).toContain('.lc-mobile.lc-app-agent-open:not(:has(.lc-modal-backdrop, .lc-settings-backdrop)) .lc-board-chrome-slot:has(.lc-agent-tray-dot) { z-index: 100; }');
    expect(css).not.toContain('.lc-map-controls:has(.lc-agent-tray-dot) { z-index: 100; }');
    expect(css).toContain('.lc-mobile.lc-app-agent-open .lc-board-chrome-slot .lc-agent-tray-dot { pointer-events: auto !important; }');
  });

  it("keeps the agent close dot awake without exposing the other menu tools", () => {
    expect(board).toContain('const chromeStackOpen = agentOpen || chromeShown.eye;');
    expect(board).toContain('{chromeTraySleeps && !agentOpen && (');
    expect(css).toContain('.lc-mobile.lc-app-agent-open .lc-chrome-stack-tray.has-agent-open > :not(.lc-agent-tray-dot) { display: none; }');
  });
});
