/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRichText } from "./AgentRichText";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
const render = async (text: string, animate = true) => {
  await act(async () => root.render(<AgentRichText text={text} animate={animate} />));
};
describe("chat Markdown and progressive reveal", () => {
  it("renders saved Markdown, inline/display math, and code while removing executable HTML", async () => {
    await render("**Hello** $x^2$\n\n$$\\sum_{i=1}^n i$$\n\n`$literal$`<script>alert(1)</script>");
    expect(host.querySelector("strong")?.textContent).toBe("Hello");
    expect(host.querySelectorAll(".katex")).toHaveLength(2);
    expect(host.querySelector(".katex-display")).not.toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("$literal$");
    expect(host.querySelector("script")).toBeNull();
  });
  it("wraps bare thinking math as inline and a lone equation as display", async () => {
    await render("The recurrence is T(n) = aT(n/b) + f(n) for some a ≥ 1.", false);
    expect(host.querySelector(".katex-display")).toBeNull();
    expect(host.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(host.textContent).toContain("The recurrence is");
    await render("For a recurrence of the form\n\nT(n) = aT(n/b)+f(n), a ≥ 1, b > 1\n\ncompare f(n).", false);
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });
  it("reveals a completed response by words without replaying saved history", async () => {
    await render(""); await render("One two three four.");
    expect(host.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(50));
    expect(host.textContent?.trim()).toBe("One");
    await act(async () => vi.advanceTimersByTime(200));
    expect(host.textContent?.trim()).toBe("One two three four.");
    expect(host.firstElementChild?.getAttribute("aria-busy")).toBe("false");
  });
  it("cleans up pending reveal when the reader leaves and honours reduced motion", async () => {
    await render(""); await render("One two three four.");
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await render(""); await render("All words immediately.");
    expect(host.textContent?.trim()).toBe("All words immediately.");
    expect(vi.getTimerCount()).toBe(0);
  });
});
