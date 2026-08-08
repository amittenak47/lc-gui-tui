import { describe, expect, it } from "vitest";

import { escapeHtml, renderCode } from "../modes/CodeDocument";

describe("escapeHtml", () => {
  it("escapes the characters that would break out of a text node", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("neutralises a closing pre / script attempt", () => {
    const raw = `</pre><script>alert(1)</script>`;
    expect(escapeHtml(raw)).not.toContain("</pre>");
    expect(escapeHtml(raw)).not.toContain("<script>");
    expect(escapeHtml(raw)).toContain("&lt;/pre&gt;");
  });

  it("preserves newlines and tabs", () => {
    expect(escapeHtml("a\n\tb")).toBe("a\n\tb");
  });
});

describe("renderCode", () => {
  it("wraps escaped source in a pre/code with a language class", () => {
    const html = renderCode("x = 1 < 2", "python");
    expect(html).toContain('class="language-python"');
    expect(html).toContain("x = 1 &lt; 2");
    expect(html).toMatch(/^<pre class="lc-code-doc-pre"><code /);
  });

  it("strips unsafe characters from the language id", () => {
    const html = renderCode("hi", 'py"><img src=x onerror=alert(1)');
    expect(html).toContain('class="language-pyimgsrcxonerroralert1"');
    expect(html).not.toContain("<img");
  });

  it("defaults blank language to plaintext", () => {
    expect(renderCode("hi", "")).toContain('class="language-plaintext"');
  });
});
