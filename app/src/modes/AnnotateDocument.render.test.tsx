/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AnnotateDocument } from "./AnnotateDocument";

afterEach(() => { vi.unstubAllGlobals(); });

it("preserves rendered words, nested scroll and selection across unrelated updates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const source = "# Notes\n\nRead these words.\n\n```js\nconst longLine = 123;\n```";
  try {
    await act(async () => root.render(<AnnotateDocument source={source} />));
    const paragraph = host.querySelector("p")!;
    const fence = host.querySelector("pre")!;
    fence.scrollLeft = 120;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(host, { childList: true, subtree: true });
    try {
      for (let i = 0; i < 5; i++) {
        await act(async () => root.render(<AnnotateDocument source={source}
          selectable={i % 2 === 0} onMeasure={() => {}} />));
      }
      expect(host.querySelector("p")).toBe(paragraph);
      expect(host.querySelector("pre")).toBe(fence);
      expect(fence.scrollLeft).toBe(120);
      expect(window.getSelection()!.toString()).toBe("Read these words.");
      expect(mutations).not.toHaveBeenCalled();
      await act(async () => root.render(<AnnotateDocument source="# Changed" />));
      expect(host.querySelector("h1")!.textContent).toBe("Changed");
    } finally { observer.disconnect(); }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
