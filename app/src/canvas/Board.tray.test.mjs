import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const board = readFileSync(new URL("./Board.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const motionPanel = readFileSync(new URL("./ChromeMotionPanel.tsx", import.meta.url), "utf8");

describe("vertical menu visibility", () => {
  it("keeps the complete menu available when hidden mode wakes", () => {
    // Main drawing chrome can stay hidden; the corner tray must still provide
    // its theme, page and agent controls, rather than restore only the eye.
    expect(board).toMatch(/const mountStackTools = chromeEnabled;/);
    expect(board).toMatch(/const chromeStackOpen = handsStacked \? menuPeek : chromeShown\.eye;/);
  });

  it("lets the same fold control operate in visible, fade and hidden modes", () => {
    // The tray is a ChromeMotionPanel since the tool trays were animated.
    const start = board.indexOf('<ChromeMotionPanel className={`lc-chrome-stack-tray');
    expect(start).toBeGreaterThan(-1);
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
    // Folding is a motion height animation now, not a CSS grid 0fr row:
    // closed collapses to zero and dips 8px toward the bottom anchor.
    expect(board).toContain('<ChromeMotionPanel className="lc-chrome-stack-fold" open={!trayFolded}>');
    expect(motionPanel).toMatch(/closed:\s*\{\s*height: 0,[^}]*y: 8/);
    expect(motionPanel).toContain('transformOrigin: "bottom center"');
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

  it("covers the tray only under the mobile sheet, not the desktop side panel", () => {
    expect(board).toContain("inert={agentOpen && mobile}");
    expect(board).toContain("aria-hidden={(agentOpen && mobile) || undefined}");
    expect(board).toContain('agentOpen && mobile ? "is-agent-covered" : ""');
    expect(board).not.toMatch(/inert=\{agentOpen\}(?!\s*&&)/);
    const start = css.indexOf(".lc-map-controls.is-agent-covered {");
    const hidden = css.slice(start, css.indexOf("}", start));
    expect(hidden).toContain("opacity: 0");
    expect(hidden).toContain("visibility: hidden");
    expect(hidden).toContain("pointer-events: none");
    expect(css).not.toContain(".lc-mobile.lc-app-agent-open .lc-map-controls {");
    expect(css).not.toContain(".lc-mobile.lc-app-agent-open .lc-board-chrome-slot .lc-map-chrome-right");
    expect(board).toContain("const chromeStackOpen = handsStacked ? menuPeek : chromeShown.eye;");
    expect(board).toContain('trayFolded ? " is-folded" : ""');
  });

  it("lets the theme popover paint beside the tray and open inward", () => {
    // An open motion panel releases its clip once it has grown, and the fold
    // itself never clips, so the popover can paint outside the tray.
    expect(motionPanel).toMatch(/open:\s*\{[^}]*transitionEnd: \{ overflow: "visible" \}/);
    const innerAt = css.indexOf("\n.lc-chrome-stack-fold-inner {");
    expect(innerAt).toBeGreaterThan(-1);
    expect(css.slice(innerAt, css.indexOf("}", innerAt))).not.toContain("overflow");
    expect(css).toContain(
      '[data-ui-handedness="left"] .lc-map-chrome-right .lc-palette-map > .lc-palette-popover-map',
    );
    const flip = css.slice(
      css.indexOf(
        '[data-ui-handedness="left"] .lc-map-chrome-right .lc-palette-map > .lc-palette-popover-map',
      ),
      css.indexOf(
        "}",
        css.indexOf(
          '[data-ui-handedness="left"] .lc-map-chrome-right .lc-palette-map > .lc-palette-popover-map',
        ),
      ),
    );
    expect(flip).toContain("left: calc(100% + 6px)");
    expect(flip).toContain("right: auto");
  });
});
