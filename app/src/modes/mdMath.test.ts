/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./AnnotateDocument";

function paper(source: string): HTMLDivElement {
  const node = document.createElement("div");
  node.innerHTML = renderMarkdown(source);
  return node;
}

describe("markdown dollars math", () => {
  it("typesets inline math and retains the styles needed for layout", () => {
    const node = paper("Euler: $e^{i\\pi} + 1 = 0$.");
    expect(node.querySelectorAll(".katex")).toHaveLength(1);
    expect(node.querySelector(".katex [style]")).not.toBeNull();
    expect(node.querySelector(".katex-display, math")).toBeNull();
    expect(node.textContent).toContain("Euler:");
  });

  it.each(["$$x^2$$", "$$\n\\frac{a}{b}\n$$", "Before\n$$x$$\nAfter", "Before $$x$$ after", "> $$x$$"])(
    "typesets display math: %s", (source) => {
      expect(paper(source).querySelectorAll(".katex-display")).toHaveLength(1);
    },
  );

  it("renders an optional equation label as escaped text", () => {
    const node = paper('$$x$$ (<img/src=x>)');
    expect(node.querySelector(".lc-math-number")?.textContent).toBe("(<img/src=x>)");
    expect(node.querySelector("img")).toBeNull();
  });

  it.each([
    "```tex\n$x$\n$$y$$\n```", "~~~\n$$x$$\n~~~", "    $x$", "`$x$` and `$$y$$`",
    "$5", "$5 and $10", " $ 5$ ", "$x $", "1$x$", "$x$2", "\\$x$", "$x\ny$", "$$",
  ])("keeps code, currency and invalid delimiters literal: %s", (source) => {
    expect(paper(source).querySelector(".katex")).toBeNull();
  });

  it("still finds math after rejected currency and inside markdown formatting", () => {
    const node = paper("Pay $ 5, then **$x_i$** and $y$.");
    expect(node.querySelectorAll(".katex")).toHaveLength(2);
    expect(node.querySelector("strong .katex")).not.toBeNull();
    expect(node.textContent).toContain("Pay $ 5,");
  });

  it("keeps escaped dollars inside math", () => {
    expect(paper(String.raw`$\text{cost: \$5}$`).querySelector(".katex")).not.toBeNull();
  });

  it("shows malformed TeX without throwing", () => {
    expect(() => renderMarkdown("$\\frac{$")).not.toThrow();
    expect(paper("$\\frac{$").querySelector(".katex-error")).not.toBeNull();
  });

  it("sanitizes source HTML and keeps untrusted TeX commands disabled", () => {
    const node = paper('<style>body{display:none}</style><script>alert(1)</script><img src=x onerror="alert(1)"><iframe></iframe><form><input></form>\n\n$\\href{javascript:alert(1)}{x}$');
    expect(node.querySelector("style, script, iframe, form, input, [onerror], [onclick], a")).toBeNull();
  });

  it("preserves ordinary markdown, GFM tables and task text", () => {
    const node = paper("# Title\n\nBody.\n\n- [x] Done\n\n| A | B |\n| - | - |\n| x | y |");
    expect(node.querySelector("h1")?.textContent).toBe("Title");
    expect(node.querySelector("p")?.textContent).toBe("Body.");
    expect(node.querySelector("li")?.textContent).toContain("Done");
    expect(node.querySelector("table")).not.toBeNull();
  });
});
