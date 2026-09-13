import katex from "katex";
import type { MarkedExtension } from "marked";

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    output: "html",
    trust: false,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

/** Dollars mode from mdmath, implemented as tokens so code stays literal. */
export function markedTexmathDollars(): MarkedExtension {
  return {
    extensions: [
      {
        name: "mathDisplay",
        level: "block",
        start: (src) => src.match(/(?:^|\n) {0,3}\$\$/)?.index,
        tokenizer(src) {
          const match = /^ {0,3}\$\$([^$]*?[^\\])\$\$(?:[ \t]*\(([^)\s]+)\))?/.exec(src);
          if (!match) return;
          return { type: "mathDisplay", raw: match[0], tex: match[1], label: match[2] };
        },
        renderer(token) {
          const math = renderMath(token.tex, true);
          return token.label
            ? `<div class="lc-math-numbered">${math}<span class="lc-math-number">(${escapeHtml(token.label)})</span></div>\n`
            : `${math}\n`;
        },
      },
      {
        name: "mathInline",
        level: "inline",
        start: (src) => src.indexOf("$"),
        tokenizer(src, tokens) {
          // Marked passes a suffix; the preceding raw token retains the context
          // needed for texmath's backslash/digit guard at the opening dollar.
          const previous = tokens.at(-1)?.raw.slice(-1) ?? "";
          if (/[\\\d$]/.test(previous)) return;
          const displayMode = src.startsWith("$$");
          const match = displayMode
            ? /^\$\$([^$]*?[^\\])\$\$/.exec(src)
            : /^\$((?:[^\s\\$])|(?:[^\s$][^\r\n]*?[^\s\\$]))\$/.exec(src);
          if (!match || /\d/.test(src.charAt(match[0].length))) return;
          return { type: "mathInline", raw: match[0], tex: match[1], displayMode };
        },
        renderer: (token) => renderMath(token.tex, token.displayMode),
      },
    ],
  };
}
