/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeAll } from "vitest";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { MorphBar } from "./MorphBar";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so `scrollWidth` is 0 for everything. Give the
  // measured panel a width so there is a size to morph to.
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return 120;
    },
  });
});

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const shell = host.querySelector(".lc-morph-bar") as HTMLElement;
  return { host, root, shell };
}

describe("MorphBar", () => {
  it("grows into its size on a normal mount", () => {
    const { shell } = mount(
      <MorphBar active="one" axis="width">
        <div data-morph-id="one">one</div>
      </MorphBar>,
    );
    expect(shell.style.width).toBe("120px");
    expect(shell.style.transition).toBe("");
  });

  it("snaps to its size when the mount is a handover", () => {
    /*
     * Split panes share one toolbar. Focus moving between them re-mounts it,
     * and replaying the open animation on every tab switch is the glitch this
     * flag exists to stop — the bar was never closed, so it must not re-open.
     */
    const { shell } = mount(
      <MorphBar active="one" axis="width" animateOnMount={false}>
        <div data-morph-id="one">one</div>
      </MorphBar>,
    );
    expect(shell.style.width).toBe("120px");
    expect(shell.style.transition).toBe("none");
  });

  it("releases the transition once the first size has landed", async () => {
    const { shell } = mount(
      <MorphBar active="one" axis="width" animateOnMount={false}>
        <div data-morph-id="one">one</div>
      </MorphBar>,
    );
    await act(async () => {
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    });
    expect(shell.style.transition).toBe("");
    expect(shell.style.width).toBe("120px");
  });

  it("keeps its box on the depth axis instead of morphing a size", () => {
    const { shell } = mount(
      <MorphBar active="one" axis="depth">
        <div data-morph-id="one">one</div>
        <div data-morph-id="two">two</div>
      </MorphBar>,
    );
    expect(shell.dataset.axis).toBe("depth");
    // Depth swaps labels by rotateY inside a fixed box, so no inline size.
    expect(shell.style.width).toBe("");
    expect(shell.style.height).toBe("");
    const activePanel = shell.querySelector(".lc-morph-panel.is-active");
    expect(activePanel?.textContent).toBe("one");
    expect(shell.querySelectorAll('.lc-morph-panel:not(.is-active)')).toHaveLength(1);
  });

  it("swaps the active panel on the depth axis without touching the box", () => {
    function Host() {
      const [active, setActive] = useState("one");
      return (
        <button type="button" onClick={() => setActive("two")}>
          <MorphBar active={active} axis="depth">
            <div data-morph-id="one">one</div>
            <div data-morph-id="two">two</div>
          </MorphBar>
        </button>
      );
    }
    const { host, root } = mount(<Host />);
    const before = host.querySelector(".lc-morph-bar") as HTMLElement;
    expect(before.querySelector(".lc-morph-panel.is-active")?.textContent).toBe("one");
    act(() => {
      host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const after = host.querySelector(".lc-morph-bar") as HTMLElement;
    expect(after.querySelector(".lc-morph-panel.is-active")?.textContent).toBe("two");
    expect(after.style.width).toBe("");
    expect(after.style.height).toBe("");
    void root;
  });
});
