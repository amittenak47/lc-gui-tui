/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { markMenuClickShouldKeepOpen, nextChatPaneFocus } from "./AgentSidePanel";

describe("nextChatPaneFocus", () => {
  it("expands a pane from the split, and restores split when tapped again", () => {
    expect(nextChatPaneFocus("split", "messages")).toBe("messages");
    expect(nextChatPaneFocus("messages", "messages")).toBe("split");
    expect(nextChatPaneFocus("split", "composer")).toBe("composer");
    expect(nextChatPaneFocus("composer", "composer")).toBe("split");
  });

  it("switching panes replaces the other rather than stacking both", () => {
    expect(nextChatPaneFocus("messages", "composer")).toBe("composer");
    expect(nextChatPaneFocus("composer", "messages")).toBe("messages");
  });
});

describe("markMenuClickShouldKeepOpen", () => {
  it("keeps the picker open for tags, chips, and the menu itself", () => {
    const menu = document.createElement("div");
    menu.className = "lc-agent-mark-menu";
    const item = document.createElement("button");
    menu.appendChild(item);
    document.body.appendChild(menu);

    const chip = document.createElement("span");
    chip.className = "lc-fn-badge";
    document.body.appendChild(chip);

    const outside = document.createElement("div");
    document.body.appendChild(outside);

    expect(markMenuClickShouldKeepOpen(item)).toBe(true);
    expect(markMenuClickShouldKeepOpen(chip)).toBe(true);
    expect(markMenuClickShouldKeepOpen(outside)).toBe(false);
    expect(markMenuClickShouldKeepOpen(null)).toBe(false);

    menu.remove();
    chip.remove();
    outside.remove();
  });
});
