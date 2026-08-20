/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeAll } from "vitest";
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
});
