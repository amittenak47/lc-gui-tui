const SLOT = "\uE000";
const GREEK = "αβγδεζηθικλμνξπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΠΡΣΤΥΦΧΨΩ";
const OP = /[=≈≠≤≥<>+×·*/,;]|-(?=\s)/;
const ABBREV = /\b(?:e\.g|i\.e|vs|Dr|Mr|Ms|Fig|Eq|cf|vs)\.$/;

/**
 * Coach turns often dump ASCII / TeX-like math without `$` / `$$`, and glue
 * several sentences into one paragraph. Normalize that before Markdown.
 */
export function formatAgentProse(text: string): string {
  if (!text.trim()) return text;
  const fences = hold(text, /```[\s\S]*?```/g, "F");
  const ticks = hold(fences.text, /`[^`]+`/g, "T");
  const normalized = normalizeDelimiters(ticks.text);
  const display = hold(normalized, /\$\$[\s\S]+?\$\$/g, "D");
  const inline = hold(display.text, /\$[^$\n]+\$/g, "I");
  const wrapped = wrapBareMath(inline.text);
  const broken = breakProse(wrapped);
  return restore(restore(restore(restore(broken, inline.held, "I"), display.held, "D"), ticks.held, "T"), fences.held, "F");
}

function hold(text: string, pattern: RegExp, tag: string): { text: string; held: string[] } {
  const held: string[] = [];
  const next = text.replace(pattern, (block) => {
    held.push(block);
    return `${SLOT}${tag}${held.length - 1}${SLOT}`;
  });
  return { text: next, held };
}

function restore(text: string, held: string[], tag: string): string {
  if (!held.length) return text;
  return text.replace(new RegExp(`${SLOT}${tag}(\\d+)${SLOT}`, "g"), (_, index) => held[Number(index)] ?? "");
}

/** `$eq$` on its own line becomes display; `$$eq$$` inside a sentence becomes inline. */
function normalizeDelimiters(text: string): string {
  return text.split("\n").map((line) => {
    if (/^\s*\|/.test(line) || /^\s*(?:\d+\.|[-*+])\s/.test(line)) {
      return line.replace(/\$\$([^$\n]+)\$\$/g, (_full, inner) => `$${inner}$`);
    }
    const trimmed = line.trim();
    const wholeDisplay = trimmed.match(/^\$\$([^$]+)\$\$([,.])?$/);
    if (wholeDisplay) return line;
    const wholeInline = trimmed.match(/^\$([^$]+)\$([,.])?$/);
    if (wholeInline && /[=≈\\]/.test(wholeInline[1]!)) {
      const inner = wholeInline[1]!;
      return line.replace(trimmed, () => `$$${inner}$$`);
    }
    return line.replace(/\$\$([^$\n]+)\$\$/g, (full, inner, offset: number) => {
      const before = line.slice(0, offset).trim();
      const after = line.slice(offset + full.length).trim();
      if (!before && !after) return full;
      return `$${inner}$`;
    });
  }).join("\n");
}

function wrapBareMath(text: string): string {
  return text.split("\n").map((line) => {
    if (/^\s*\|?\s*:?-[-:]/.test(line)) return line;
    if (/^\s*\|/.test(line)) {
      return line.split("|").map((cell, index, all) => {
        if (index === 0 || index === all.length - 1) return cell;
        return wrapInline(cell, false);
      }).join("|");
    }
    const display = !/^\s*(?:\d+\.|[-*+#])/.test(line);
    return wrapInline(line, display);
  }).join("\n");
}

function wrapInline(line: string, allowDisplay: boolean): string {
  let out = "";
  let i = 0;
  let steps = 0;
  while (i < line.length && steps < line.length + 8) {
    steps += 1;
    if (line.startsWith(SLOT, i)) {
      const end = line.indexOf(SLOT, i + 1);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (isMathStart(line, i)) {
      const end = scanExpr(line, i);
      if (end > i) {
        out += `$${tidyTex(line.slice(i, end))}$`;
        i = end;
        continue;
      }
    }
    out += line[i];
    i += 1;
  }
  if (!allowDisplay) return out;
  const lead = out.match(/^\s*/)?.[0] ?? "";
  const tail = out.match(/\s*$/)?.[0] ?? "";
  const trimmed = out.trim();
  if (trimmed.startsWith("$$") || !trimmed.startsWith("$") || !trimmed.endsWith("$")) return out;
  const inner = trimmed.slice(1, -1);
  if (inner.includes("$") || !/[=≈]/.test(inner)) return out;
  return `${lead}$$${inner}$$${tail}`;
}

function isMathStart(s: string, i: number): boolean {
  if (i > 0 && /[A-Za-z\\]/.test(s[i - 1]!)) return false;
  const rest = s.slice(i);
  if (/^(?:T|O|W|f|g|h|Θ|Ω)\(/.test(rest)) return true;
  if (/^[a-z0-9][TOfWΘΩ]\(/.test(rest)) return true;
  if (/^log[_^]/.test(rest)) return true;
  if (/^\\(?:frac|sum|prod|log|Theta|Omega|le|ge|cdot|times)\b/.test(rest)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*[\^_]/.test(rest)) return true;
  if (/^[A-Za-z]\/[A-Za-z]/.test(rest)) return true;
  if (GREEK.includes(rest[0] ?? "") && /^\S\s*[<>≤≥≠≈]/.test(rest)) return true;
  if (/^[a-zA-Z]\s*[<>≤≥≠≈]/.test(rest)) return true;
  return false;
}

function scanBrace(s: string, i: number): number {
  if (s[i] !== "{") return i;
  let depth = 1;
  let j = i + 1;
  while (j < s.length && depth) {
    if (s[j] === "{") depth += 1;
    else if (s[j] === "}") depth -= 1;
    j += 1;
  }
  return j;
}

function scanParen(s: string, i: number): number {
  if (s[i] !== "(") return i;
  let depth = 1;
  let j = i + 1;
  while (j < s.length && depth) {
    if (s[j] === "(") depth += 1;
    else if (s[j] === ")") depth -= 1;
    j += 1;
  }
  return j;
}

function scanAtom(s: string, i: number): number {
  let j = i;
  if (/^[a-z0-9]/.test(s[j] ?? "") && /[TOfWΘΩ]/.test(s[j + 1] ?? "")) j += 1;
  if (s.startsWith("\\", j)) {
    j += 1;
    while (/[A-Za-z]/.test(s[j] ?? "")) j += 1;
    if (s[j] === "{") j = scanBrace(s, j);
  } else if (s.startsWith("log", j) && !/[A-Za-z]/.test(s[j + 3] ?? "")) {
    j += 3;
  } else {
    const ident = scanIdent(s, j);
    if (ident === j) {
      if (/[0-9]/.test(s[j] ?? "")) {
        while (/[0-9]/.test(s[j] ?? "") || (s[j] === "." && /[0-9]/.test(s[j + 1] ?? ""))) j += 1;
      } else {
        return i;
      }
    } else {
      j = ident;
    }
  }
  for (let hops = 0; hops < 8; hops += 1) {
    if (s[j] === "_" || s[j] === "^") {
      j += 1;
      if (s[j] === "{") j = scanBrace(s, j);
      else if (s[j]) j += 1;
      continue;
    }
    break;
  }
  if (s[j] === "(") j = scanParen(s, j);
  return j > i ? j : i;
}

/** Single-letter names, greek, and T/O/W/f — not English words like "and". */
function scanIdent(s: string, j: number): number {
  const ch = s[j] ?? "";
  if (GREEK.includes(ch)) return j + 1;
  if (/[TOfWgh]/.test(ch) && !/[A-Za-z]/.test(s[j + 1] ?? "")) return j + 1;
  if (/[A-Za-z]/.test(ch) && !/[A-Za-z]/.test(s[j + 1] ?? "")) {
    let k = j + 1;
    while (/[0-9]/.test(s[k] ?? "")) k += 1;
    return k;
  }
  return j;
}

function scanExpr(s: string, start: number): number {
  let i = scanAtom(s, start);
  if (i === start) return start;
  for (let hops = 0; hops < s.length + 4; hops += 1) {
    let j = i;
    while (s[j] === " ") j += 1;
    const ch = s[j] ?? "";
    if (OP.test(ch) || ch === "-") {
      const opAt = j;
      j += 1;
      while (s[j] === " ") j += 1;
      const next = scanAtom(s, j);
      if (next === j) {
        if (ch === "-" && s[opAt + 1] !== " ") return i;
        break;
      }
      i = next;
      continue;
    }
    break;
  }
  while (i > start && s[i - 1] === " ") i -= 1;
  return i;
}

export function tidyTex(source: string): string {
  return source
    .replace(/([a-z])([TOfWΘΩ])\(/g, "$1\\,$2(")
    .replace(/(?<!\\)log_([A-Za-z0-9]+)/g, "\\log_{$1}")
    .replace(/(?<!\\)log\^/g, "\\log^")
    .replace(/([A-Za-z0-9])\^([A-Za-z0-9]+)/g, "$1^{$2}")
    .replace(/(?<!\\)Θ/g, "\\Theta")
    .replace(/(?<!\\)Ω/g, "\\Omega")
    .replace(/·/g, "\\cdot")
    .replace(/×/g, "\\times")
    .replace(/≈/g, "\\approx")
    .replace(/≠/g, "\\neq")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/−/g, "-");
}

function breakProse(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*\|/.test(line) || /^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      out.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(splitSentences(line));
  }
  let joined = out.join("\n").replace(/([^\n])\n(?=(?:\d+\.|[-*+])\s)/g, "$1\n\n");
  joined = joined.replace(/\n{3,}/g, "\n\n");
  return joined;
}

function splitSentences(line: string): string {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line.startsWith(SLOT, i)) {
      const end = line.indexOf(SLOT, i + 1);
      if (end !== -1) {
        buf += line.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    buf += line[i];
    if ((line[i] === "." || line[i] === "!" || line[i] === "?") && /\s/.test(line[i + 1] ?? "") && /[A-Z0-9]/.test(line[i + 2] ?? "")) {
      if (line[i] === "." && ABBREV.test(buf)) continue;
      parts.push(buf.trimEnd());
      buf = "";
      while (/\s/.test(line[i + 1] ?? "")) i += 1;
    }
  }
  if (buf) parts.push(buf);
  return parts.join("\n\n");
}
