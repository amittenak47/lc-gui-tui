/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { ReasoningBlock } from "./ReasoningBlock";

describe("ReasoningBlock", () => {
  it("hides when empty and folds the full text", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ReasoningBlock text="   " running={false} />);
    });
    expect(host.querySelector(".lc-agent-reasoning")).toBeNull();

    await act(async () => {
      root.render(<ReasoningBlock text={"First I look.\n\nThen I name SGD."} running={false} />);
    });
    const toggle = host.querySelector(".lc-agent-process-toggle") as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".lc-agent-reasoning-body")).toBeNull();
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".lc-agent-reasoning-body")?.textContent).toContain("Then I name SGD.");
    root.unmount();
    host.remove();
  });
});
