import type { VizProgram } from "./schema";

const MATH_SLOT = "\uE000";

/** Titles like `master-tree` are ids; prefer the human frame label. */
export function isMachineTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(trimmed);
}

export function drawingHeading(program: VizProgram, frameIndex = 0): string {
  const title = program.title.trim();
  const label = program.frames[frameIndex]?.label?.trim() ?? "";
  if (label && (!title || isMachineTitle(title))) return label;
  return title || label || "Diagram";
}

/**
 * Coach notes are often one run-on ASCII line. Turn that into markdown the
 * student can actually read, including `$…$` for KaTeX.
 */
export function formatVizProse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const held: string[] = [];
  const shielded = trimmed.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, (block) => {
    held.push(block);
    return `${MATH_SLOT}${held.length - 1}${MATH_SLOT}`;
  });
  const mathified = breakProse(applyAsciiMath(shielded));
  return mathified.replace(new RegExp(`${MATH_SLOT}(\\d+)${MATH_SLOT}`, "g"), (_, index) => held[Number(index)] ?? "");
}

function texInner(source: string): string {
  return source
    .replace(/log_([A-Za-z0-9]+)/g, "\\log_{$1}")
    .replace(/([A-Za-z0-9])\^([A-Za-z0-9]+)/g, "$1^{$2}")
    .replace(/·/g, "\\cdot")
    .replace(/×/g, "\\times")
    .replace(/≈/g, "\\approx")
    .replace(/≠/g, "\\neq");
}

function math(source: string): string {
  return `$${texInner(source)}$`;
}

function applyAsciiMath(text: string): string {
  let next = text;
  next = next.replace(/\b([A-Za-z])\^\(([^)]+)\)/g, (_, base, inner) => math(`${base}^{${inner}}`));
  next = next.replace(/\(([A-Za-z]\/[A-Za-z]\^[A-Za-z0-9]+)\)\^([A-Za-z0-9]+)/g, (_, body, exp) =>
    math(`(${body})^{${exp}}`),
  );
  next = next.replace(/\b([A-Za-z])\/([A-Za-z])\^([A-Za-z0-9]+)\b/g, (_, num, den, exp) =>
    math(`${num}/${den}^{${exp}}`),
  );
  next = next.replace(/\b([A-Za-z])\^([A-Za-z0-9]+)\b/g, (_, base, exp) => math(`${base}^{${exp}}`));
  next = next.replace(/\blog_([A-Za-z0-9]+)\s*([A-Za-z0-9]+)?/g, (_, base, arg) =>
    math(arg ? `\\log_{${base}} ${arg}` : `\\log_{${base}}`),
  );
  next = next.replace(/\b(T|O|Θ|Ω|W)\(([^)]{1,48})\)/g, (_, fn, args) => math(`${fn}(${args})`));
  next = next.replace(
    /\b([A-Za-z])\s*=\s*(\d+\s*\/\s*\d+)\s*([<>]=?\s*\d+)?/g,
    (_, name, ratio, tail) => math(`${name}=${ratio}${tail ?? ""}`),
  );
  next = next.replace(
    /\b((?:[a-z]\s*=\s*\d+)(?:\s*,\s*[a-z]\s*=\s*\d+){1,6})\b/gi,
    (block) => math(block.replace(/\s*,\s*/g, ",\\ ")),
  );
  next = next.replace(
    /\b(\d+(?:\s*[+\-]\s*\d+){2,}\s*=\s*[\d.]+)\b/g,
    (block) => math(block),
  );
  return next;
}

function breakProse(text: string): string {
  const withBreaks = text
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, "$1\n\n")
    .replace(/\s+→\s+/g, "\n\n→ ");
  return withBreaks.replace(/\n{3,}/g, "\n\n").trim();
}
