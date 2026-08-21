/**
 * Let the app's paper show through a captured page's blank background.
 *
 * `prefixSelectors` rewrites a site's `html` / `body` / `:root` rules onto the
 * document container, which is right for everything except one declaration: the
 * background. A page that says `body { background: #fff }` — and nearly every
 * page says some version of it — arrives as an opaque white sheet laid over the
 * pad's paper, so a themed app renders a bright rectangle in the middle of it
 * and ink drawn on top reads as ink on a different surface.
 *
 * Only *blank* backgrounds give way. A near-white or near-black-on-white page is
 * saying nothing in particular and the theme should win; a page with a real
 * colour, an image or a gradient has made a decision, and dropping it would
 * leave its own light text on the app's light paper. When in doubt, keep it —
 * an unthemed background is untidy, an unreadable one is broken.
 */

/** Above this, a background is doing no work that the paper cannot do. */
const BLANK_LUMINANCE = 0.86;

const NAMED_BLANK = new Set(["white", "transparent", "inherit", "initial", "unset", "revert"]);

/** sRGB relative luminance, 0..1, or null if this is not a plain colour. */
export function cssColorLuminance(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const wide = digits.length > 4;
    const step = wide ? 2 : 1;
    const part = (index: number) => {
      const slice = digits.slice(index * step, index * step + step);
      const n = parseInt(wide ? slice : slice + slice, 16);
      return n / 255;
    };
    return luminanceOf(part(0), part(1), part(2));
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (text: string): number | null => {
      if (text.endsWith("%")) {
        const pct = Number.parseFloat(text);
        return Number.isFinite(pct) ? pct / 100 : null;
      }
      const n = Number.parseFloat(text);
      return Number.isFinite(n) ? n / 255 : null;
    };
    const r = channel(parts[0]!);
    const g = channel(parts[1]!);
    const b = channel(parts[2]!);
    if (r == null || g == null || b == null) return null;
    return luminanceOf(r, g, b);
  }

  return null;
}

function luminanceOf(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Whether this background value is blank enough for the theme to replace.
 *
 * Anything with a `url()`, a gradient or more than one layer is a decision, not
 * a default, and is kept whatever colour it resolves to.
 */
export function isBlankPaperBackground(raw: string): boolean {
  const value = raw.trim().toLowerCase().replace(/\s*!important\s*$/, "");
  if (!value) return false;
  if (value.includes("url(") || value.includes("gradient(") || value.includes(",")) {
    // A comma means either several layers or a functional colour; the colour
    // case is caught below, so only reject when it is not one.
    if (!/^rgba?\(/.test(value)) return false;
  }
  if (NAMED_BLANK.has(value)) return true;
  const luminance = cssColorLuminance(value);
  return luminance != null && luminance >= BLANK_LUMINANCE;
}

/** Does this already-prefixed selector list target the container itself? */
export function targetsDocRoot(selectors: string, scope: string): boolean {
  return selectors.split(",").some((part) => part.trim() === scope);
}

/**
 * Strip blank background declarations from a root rule's body.
 *
 * Declarations are split on top-level semicolons so a `url(a;b)` or a nested
 * function cannot cut one in half.
 */
export function dropBlankPaper(body: string): string {
  const decls = splitDecls(body);
  const kept: string[] = [];
  for (const decl of decls) {
    const colon = decl.indexOf(":");
    if (colon < 0) {
      kept.push(decl);
      continue;
    }
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (prop !== "background" && prop !== "background-color") {
      kept.push(decl);
      continue;
    }
    if (!isBlankPaperBackground(decl.slice(colon + 1))) kept.push(decl);
  }
  if (kept.length === decls.length) return body;
  return kept.join(";");
}

function splitDecls(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote && body[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}
