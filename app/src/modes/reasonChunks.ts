/**
 * Chop a chain-of-thought into tap-sized Thinking steps.
 *
 * Models usually write one narrative with ordinary line breaks, not `#`
 * headings. Numbered / bullet lists stay inside the thought that introduced
 * them — those are document points, not new steps.
 */

import type { CoachProcessEvent } from "../api/types";

export const REASON_STEP_CAP = 12;
const TARGET_CHARS = 480;
const MAX_SENTENCES = 3;
const LIST_ITEM = /^(?:\d+[.)]|[-*•])\s/;

export function splitReasonSteps(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parts = splitHeadings(trimmed);
  if (parts.length < 2) parts = splitBlankParagraphs(trimmed);
  parts = parts.flatMap(splitOneThought);
  parts = mergeTiny(parts);
  return capSteps(parts);
}

/** Fold a stored/streamed reason blob into one process row per thought. */
export function chunkReasonEvents(events: CoachProcessEvent[]): CoachProcessEvent[] {
  const out: CoachProcessEvent[] = [];
  for (const event of events) {
    // Live `updateId` rows are already one thought from the stream splitter.
    // Re-chunking them as they grow remounts chips and dumps the rest at once.
    if (
      event.kind !== "stage"
      || event.label !== "reason"
      || !event.detail?.trim()
      || event.updateId
    ) {
      out.push(event);
      continue;
    }
    const parts = splitReasonSteps(event.detail);
    if (parts.length <= 1) {
      out.push(event);
      continue;
    }
    for (const [index, detail] of parts.entries()) {
      out.push({
        ...event,
        detail,
        updateId: event.updateId ? `${event.updateId}:${index}` : event.updateId,
      });
    }
  }
  return out;
}

function splitOneThought(block: string): string[] {
  const text = block.trim();
  if (!text) return [];
  if (text.length <= TARGET_CHARS || isListHeavy(text)) return [text];
  const byLine = splitThoughtLines(text);
  if (byLine.length > 1) {
    return byLine.flatMap((part) =>
      part.length > TARGET_CHARS && !isListHeavy(part) ? packSentences(part) : [part],
    );
  }
  return packSentences(text);
}

function splitHeadings(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const heading = trimmed.startsWith("# ") || trimmed.startsWith("## ");
    if (heading && current.trim()) {
      out.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function splitBlankParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isListItem(line: string): boolean {
  return LIST_ITEM.test(line.trimStart());
}

function isListHeavy(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const listed = lines.filter(isListItem).length;
  // Intro + closer around a list still count as that thought.
  return listed >= 2 && listed >= lines.length - 2;
}

function isQuoteLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("\"") || t.startsWith("'") || t.startsWith("“") || t.startsWith("«");
}

function thoughtEnded(block: string): boolean {
  const last = block
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find(Boolean) ?? "";
  if (!last || last.endsWith(":")) return false;
  return /[.!?]["”']?$/.test(last);
}

function looksLikeNewThought(line: string): boolean {
  const t = line.trim();
  if (!t || isListItem(t) || isQuoteLine(t)) return false;
  return /\p{Lu}/u.test(t[0] ?? "");
}

/** New thought after a finished sentence; colon+list/quote stay attached. */
function splitThoughtLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length < 2) return [text.trim()].filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (current && thoughtEnded(current) && looksLikeNewThought(trimmed)) {
      out.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) out.push(current.trim());
  return out.length > 0 ? out : [text.trim()];
}

function isListMarkerPeriod(text: string, periodIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", periodIndex - 1) + 1;
  const prefix = text.slice(lineStart, periodIndex).trim();
  return /^\d+$/.test(prefix);
}

function isAbbrevPeriod(text: string, periodIndex: number): boolean {
  let i = periodIndex;
  while (i > 0 && /[A-Za-z]/.test(text[i - 1]!)) i -= 1;
  const word = text.slice(i, periodIndex);
  if (word.length > 0 && word.length <= 2) return true;
  if (periodIndex >= 3 && text[periodIndex - 2] === "." && /[a-z]/i.test(text[periodIndex - 1]!)) {
    return true;
  }
  return false;
}

function splitSentences(text: string): string[] {
  if (isListHeavy(text)) return [text.trim()];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === "." && (isListMarkerPeriod(text, i) || isAbbrevPeriod(text, i))) continue;
    let j = i + 1;
    while (j < text.length && /["”']/.test(text[j]!)) j += 1;
    const rest = text.slice(j);
    const ws = rest.match(/^\s+/)?.[0];
    if (ws === undefined && j < text.length) continue;
    const after = rest.slice(ws?.length ?? 0);
    const next = after[0];
    if (next && !/\p{Lu}/u.test(next) && next !== "\"" && next !== "“") continue;
    const sentence = text.slice(start, j).trim();
    if (sentence) out.push(sentence);
    start = j + (ws?.length ?? 0);
    i = start - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [text.trim()];
}

function packSentences(text: string): string[] {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return [text.trim()];
  const out: string[] = [];
  let current: string[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length) out.push(current.join(" "));
    current = [];
    chars = 0;
  };
  for (const sentence of sentences) {
    const nextLen = chars + sentence.length;
    if (
      current.length > 0
      && (current.length >= MAX_SENTENCES || nextLen > TARGET_CHARS)
    ) {
      flush();
    }
    current.push(sentence);
    chars += sentence.length + 1;
  }
  flush();
  return out;
}

function mergeTiny(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const prev = out.at(-1);
    if (prev && part.length < 32 && !/[.!?]$/.test(part.trim()) && !isListItem(part)) {
      out[out.length - 1] = `${prev}\n${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

function capSteps(parts: string[]): string[] {
  if (parts.length <= REASON_STEP_CAP) return parts;
  return [
    ...parts.slice(0, REASON_STEP_CAP - 1),
    parts.slice(REASON_STEP_CAP - 1).join("\n\n"),
  ];
}
