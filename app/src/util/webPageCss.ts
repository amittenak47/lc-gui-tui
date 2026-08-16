/**
 * Captured page CSS must not style the app chrome.
 *
 * `<style>` / `<link rel=stylesheet>` inside `.lc-web-doc` still apply to the
 * whole document. NVIDIA `body`/`header`/` :root` then paint a white strip
 * above our header and restyle "lc whiteboard". Prefix every selector with
 * `.lc-web-doc`; rewrite `html`/`body`/` :root` to the paper itself.
 */

export const WEB_DOC_SCOPE = ".lc-web-doc";

const SKIP_AT = /^(keyframes|-webkit-keyframes|-moz-keyframes|font-face|counter-style|property|font-feature-values)\b/i;
const NEST_AT = /^(media|supports|layer|container|scope|document)\b/i;

export function absolutizeCssUrls(css: string, baseUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
    const url = raw.trim();
    if (!url || /^(data:|https?:|blob:|#)/i.test(url)) return match;
    try {
      const abs = new URL(url, baseUrl).href;
      return `url(${quote}${abs}${quote})`;
    } catch {
      return match;
    }
  });
}

export function scopeCss(css: string, scope = WEB_DOC_SCOPE): string {
  const stripped = css.replace(/@import\b[^;]+;/gi, "");
  return prefixBlock(stripped, scope);
}

function prefixBlock(css: string, scope: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = css[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "@") {
      const at = readAtRule(css, i, scope);
      out += at.text;
      i = at.next;
      continue;
    }
    const brace = indexOfUnquoted(css, i, "{");
    if (brace < 0) {
      out += css.slice(i);
      break;
    }
    const selectors = css.slice(i, brace);
    const body = readCurly(css, brace);
    out += `${prefixSelectors(selectors, scope)}{${rewriteDecls(body.body)}}`;
    i = body.next;
  }
  return out;
}

function readAtRule(
  css: string,
  start: number,
  scope: string,
): { text: string; next: number } {
  const brace = indexOfUnquoted(css, start, "{");
  const semi = indexOfUnquoted(css, start, ";");
  if (brace < 0 || (semi >= 0 && semi < brace)) {
    const next = semi < 0 ? css.length : semi + 1;
    return { text: css.slice(start, next), next };
  }
  const header = css.slice(start, brace);
  const name = header.slice(1).trim();
  const inner = readCurly(css, brace);
  if (SKIP_AT.test(name)) {
    return { text: css.slice(start, inner.next), next: inner.next };
  }
  if (NEST_AT.test(name)) {
    return {
      text: `${header}{${prefixBlock(inner.body, scope)}}`,
      next: inner.next,
    };
  }
  return { text: css.slice(start, inner.next), next: inner.next };
}

function readCurly(css: string, openBrace: number): { body: string; next: number } {
  let depth = 0;
  let i = openBrace;
  let quote: string | null = null;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: css.slice(openBrace + 1, i), next: i + 1 };
      }
    }
    i += 1;
  }
  return { body: css.slice(openBrace + 1), next: n };
}

function indexOfUnquoted(css: string, from: number, needle: string): number {
  let quote: string | null = null;
  for (let i = from; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === needle) return i;
  }
  return -1;
}

export function prefixSelectors(raw: string, scope = WEB_DOC_SCOPE): string {
  return raw
    .split(",")
    .map((part) => {
      const lead = part.match(/^\s*/)?.[0] ?? "";
      const trail = part.match(/\s*$/)?.[0] ?? "";
      let s = part.trim();
      if (!s) return part;
      if (s.includes(scope)) return part;
      // Drop html/body classes and ids — those live on the captured document,
      // not on `.lc-web-doc`. Keeping `body.hp` as `.lc-web-doc.hp` matches nothing.
      s = s.replace(/^:root\b(?:[.#:][^\s]*)*/, scope);
      s = s.replace(/^html(?:[.#[][^\s]*)*(?:\s+body(?:[.#[][^\s]*)*)?/, scope);
      if (!s.startsWith(scope)) s = s.replace(/^body(?:[.#[][^\s]*)*/, scope);
      if (s.startsWith(scope)) return `${lead}${s}${trail}`;
      return `${lead}${scope} ${s}${trail}`;
    })
    .join(",");
}

function rewriteDecls(body: string): string {
  return body
    .replace(/position\s*:\s*(fixed|sticky)/gi, "position:absolute")
    .replace(/\b100vw\b/g, "100%");
}
