/**
 * Normalize run-on LeetCode problem statements before markdown rendering.
 *
 * Corpus descriptions often arrive as one paragraph with Example/Input/Output
 * jammed together and exponents flattened (104 → 10⁴). This runs only on
 * StatementDocument — not on user-authored MdInk pages.
 */

const HTML_HINT = /<(?:p|br|sup|li|strong)\b/i;

const HTML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const SECTION_LABEL =
  "(?:Example\\s+\\d+|Input|Output|Explanation|Constraints|Note|Follow-up|Follow up)";

function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function looksLikeHtml(raw: string): boolean {
  return HTML_HINT.test(raw);
}

function tidyHtml(raw: string): string {
  let text = raw;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  for (const [entity, ch] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(ch);
  }
  return text;
}

/** Put section labels at the start of their own paragraph. */
function breakBeforeSectionLabels(text: string): string {
  let out = text.replace(
    new RegExp(`(?<!\\n)(${SECTION_LABEL}:)`, "gi"),
    "\n\n$1",
  );
  // Single newline before a label → blank line (idempotent when already \n\n).
  out = out.replace(new RegExp(`(?<!\\n)\\n(?!\\n)(?=${SECTION_LABEL}:)`, "gi"), "\n\n");
  return out;
}

/** Move content after a label onto the following line (green-box layout). */
function breakLabelContent(text: string): string {
  return text.replace(
    new RegExp(`^(${SECTION_LABEL}):[ \\t]+(\\S)`, "gim"),
    "$1:\n\n$2",
  );
}

/**
 * LeetCode flattens 10^n as `10n` (e.g. 104). Restore superscript.
 * Leave literals like 100 alone.
 */
function convertExponents(text: string): string {
  let out = text.replace(/\b10\^(\d+)\b/g, "10<sup>$1</sup>");
  out = out.replace(/\b10([2-9])\b/g, "10<sup>$1</sup>");
  return out;
}

/**
 * Inside the Constraints section, put each bound / identity on its own line.
 */
function splitConstraintItems(text: string): string {
  const match = /Constraints:\s*/i.exec(text);
  if (!match || match.index === undefined) return text;

  const before = text.slice(0, match.index);
  const afterLabel = text.slice(match.index + match[0].length);
  // Stop at the next section label so we do not touch Note / Follow-up bodies.
  const next = new RegExp(`\\n\\n${SECTION_LABEL}:`, "i").exec(afterLabel);
  const body = next ? afterLabel.slice(0, next.index) : afterLabel;
  const rest = next ? afterLabel.slice(next.index) : "";

  let split = body.trim();
  // "1 <= a … 1 <= b" / after </sup>
  split = split.replace(/\s+(?=\d+\s*(?:<=|>=))/g, "\n");
  // "m == mat.length n == mat[i].length"
  split = split.replace(/\s+(?=[A-Za-z_]\w*\s*==)/g, "\n");

  return `${before}Constraints:\n\n${split}${rest}`;
}

function fixConstraintProse(text: string): string {
  const match = /Constraints:/i.exec(text);
  if (!match || match.index === undefined) return text;

  const head = text.slice(0, match.index);
  let tail = text.slice(match.index);
  // Jammed after a numeric bound or </sup> (e.g. "…length All the integers…").
  tail = tail.replace(/([\d>])\s+([A-Z][a-z])/g, "$1\n\n$2");
  tail = tail.replace(/\s+(All\s+the\s+[\w\s,']+?\.)/g, "\n\n$1");
  return head + tail;
}

/**
 * Prepare a problem statement for `renderMarkdown`.
 */
export function normalizeStatementForMarkdown(raw: string): string {
  let text = normalizeNewlines(raw);

  if (looksLikeHtml(text)) {
    text = tidyHtml(text);
  }

  text = breakBeforeSectionLabels(text);
  text = breakLabelContent(text);
  text = convertExponents(text);
  text = splitConstraintItems(text);
  text = fixConstraintProse(text);
  text = normalizeNewlines(text);

  return text.trim();
}
