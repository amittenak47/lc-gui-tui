/**
 * Pack selected document marks into coach prompt context.
 *
 * Ask AI no longer lives as a mini composer on the footnote card — marks are
 * attached as chips on the main panel, and this turns those marks into prose
 * the model can use: the block text, links, notes, and prior thread titles,
 * with thread root ids deduped across the selection.
 */

import {
  type DocFootnote,
  type DocFootnoteThread,
} from "../util/docFootnotes";

/** Soft budget for mark context (leaves room for the question + history). */
export const MARK_CONTEXT_BUDGET_CHARS = 4500;

/**
 * Daemon `clip(question)` for corpus Ask. Keep in sync with
 * `ASK_QUESTION_MAX` in `src/llm/helpers.rs`.
 */
export const PROBLEM_ASK_CLIP_CHARS = 4000;

/**
 * Document / whiteboard Ask — no code dump. Keep in sync with
 * `PAD_ASK_QUESTION_MAX` in `src/llm/helpers.rs`.
 */
export const PAD_ASK_CLIP_CHARS = 12_000;

export interface PackFootnoteContextOptions {
  numbers?: ReadonlyMap<string, number>;
  budget?: number;
  /**
   * Known thread titles keyed by rootId — when the mark only stored a rootId,
   * the live coach transcript can fill the title.
   */
  threadTitles?: ReadonlyMap<string, string>;
  /** Drop marks that do not fit instead of condensing the last one. */
  omitOverflow?: boolean;
}

function condense(text: string, max = 700): string {
  const flat = text.replace(/\r/g, "").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, Math.floor(max * 0.65)).trimEnd();
  const tail = flat.slice(-Math.floor(max * 0.25)).trimStart();
  return `${head}\n… [${flat.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

function linkLine(link: { url: string; title?: string }): string {
  return link.title?.trim() ? `${link.title.trim()} — ${link.url}` : link.url;
}

function threadLine(
  thread: DocFootnoteThread,
  titles?: ReadonlyMap<string, string>,
): string {
  const title =
    thread.title?.trim() ||
    titles?.get(thread.rootId)?.trim() ||
    thread.rootId;
  return `${title} [${thread.rootId}]`;
}

/** Collect unique thread roots across marks (first title wins). */
export function dedupeFootnoteThreads(
  footnotes: readonly DocFootnote[],
): DocFootnoteThread[] {
  const seen = new Set<string>();
  const out: DocFootnoteThread[] = [];
  for (const footnote of footnotes) {
    for (const thread of footnote.threads ?? []) {
      if (seen.has(thread.rootId)) continue;
      seen.add(thread.rootId);
      out.push(thread);
    }
    if (footnote.threadRootId && !seen.has(footnote.threadRootId)) {
      seen.add(footnote.threadRootId);
      out.push({
        rootId: footnote.threadRootId,
        title: "Thread",
        createdAt: footnote.createdAt,
      });
    }
  }
  return out;
}

/**
 * One mark's context block. Returns null when there is nothing useful to say.
 */
export function formatFootnoteContext(
  footnote: DocFootnote,
  number: number | undefined,
  options?: PackFootnoteContextOptions,
): string | null {
  const label =
    number != null ? `Mark ${number}` : `Mark ${footnote.id.slice(0, 8)}`;
  const lines: string[] = [`### ${label}`];

  const body = (footnote.blockText ?? footnote.excerpt ?? "").trim();
  if (body) lines.push("Text:", condense(body));

  const links: string[] = [];
  if (footnote.kind === "search" && footnote.url) {
    links.push(
      linkLine({
        url: footnote.url,
        title: footnote.query || "Search",
      }),
    );
  }
  for (const link of footnote.userLinks ?? []) {
    links.push(linkLine(link));
  }
  if (links.length > 0) {
    lines.push("Links:");
    for (const line of links) lines.push(`- ${line}`);
  }

  const notes = (footnote.notes ?? [])
    .map((note) => note.text.trim())
    .filter(Boolean);
  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) lines.push(`- ${condense(note, 400)}`);
  }

  const subMarks = (footnote.subMarks ?? [])
    .map((mark) => `${mark.kind}: ${mark.excerpt}`.trim())
    .filter((line) => line.length > 2);
  if (subMarks.length > 0) {
    lines.push("Sub-marks:");
    for (const line of subMarks) lines.push(`- ${condense(line, 200)}`);
  }

  const threads = dedupeFootnoteThreads([footnote]);
  if (threads.length > 0) {
    lines.push("Prior chat threads (do not re-list duplicates across marks):");
    for (const thread of threads) {
      lines.push(`- ${threadLine(thread, options?.threadTitles)}`);
    }
  }

  if (lines.length <= 1) return null;
  return lines.join("\n");
}

/**
 * Pack several attached marks into one prompt section.
 *
 * Thread root ids are deduped globally so the same conversation is not pasted
 * once per mark that pointed at it.
 */
export function packFootnoteContext(
  footnotes: readonly DocFootnote[],
  options?: PackFootnoteContextOptions,
): string {
  if (footnotes.length === 0) return "";
  const budget = options?.budget ?? MARK_CONTEXT_BUDGET_CHARS;
  const numbers = options?.numbers;
  const sharedThreads = dedupeFootnoteThreads(footnotes);
  const sharedIds = new Set(sharedThreads.map((thread) => thread.rootId));

  const parts: string[] = ["Attached document marks:"];
  let used = parts[0]!.length;

  for (const footnote of footnotes) {
    // Strip per-mark thread lists when packing many marks — emit once at end.
    const solo =
      footnotes.length === 1
        ? footnote
        : {
            ...footnote,
            threads: undefined,
            threadRootId: undefined,
          };
    const block = formatFootnoteContext(
      solo,
      numbers?.get(footnote.id),
      options,
    );
    if (!block) continue;
    if (used + block.length + 2 > budget) {
      if (options?.omitOverflow) break;
      const room = Math.max(120, budget - used - 40);
      parts.push(condense(block, room));
      used = budget;
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }

  if (footnotes.length > 1 && sharedThreads.length > 0 && used < budget) {
    const header = "Prior chat threads (deduped across marks):";
    const lines = sharedThreads.map(
      (thread) => `- ${threadLine(thread, options?.threadTitles)}`,
    );
    const section = [header, ...lines].join("\n");
    if (used + section.length + 2 <= budget) {
      parts.push(section);
    } else if (sharedIds.size > 0) {
      parts.push(
        `${header}\n- ${[...sharedIds].slice(0, 8).join(", ")}${
          sharedIds.size > 8 ? "…" : ""
        }`,
      );
    }
  }

  return parts.length > 1 ? parts.join("\n\n") : "";
}

/** Quote + question, the part of an Ask that must survive the daemon clip. */
export function coreAskText(question: string, quote?: string): string {
  const asked = question.trim();
  const quoted = quote?.trim() ?? "";
  if (quoted && asked) return `From the document:\n\n“${quoted}”\n\n${asked}`;
  if (quoted) return `From the document:\n\n“${quoted}”`;
  return asked;
}

export interface AssembleAskPromptInput {
  question: string;
  quote?: string;
  marks?: readonly DocFootnote[];
  numbers?: ReadonlyMap<string, number>;
  /** Daemon clip for this workspace — {@link PROBLEM_ASK_CLIP_CHARS} or {@link PAD_ASK_CLIP_CHARS}. */
  budget: number;
  threadTitles?: ReadonlyMap<string, string>;
}

export interface AssembleAskPromptResult {
  prompt: string;
  includedMarkIds: string[];
  omittedMarkIds: string[];
  questionTruncated: boolean;
}

function includedIdsFromPack(
  packed: string,
  marks: readonly DocFootnote[],
  numbers?: ReadonlyMap<string, number>,
): string[] {
  const ids: string[] = [];
  for (const mark of marks) {
    const number = numbers?.get(mark.id);
    const needle = number != null ? `### Mark ${number}` : `### Mark ${mark.id.slice(0, 8)}`;
    if (packed.includes(needle)) ids.push(mark.id);
  }
  return ids;
}

/**
 * Build one Ask string that fits `budget`.
 *
 * The quote and question are reserved first so the daemon's front-clip cannot
 * delete the ask. Whole marks that do not fit are omitted (not half-chopped).
 * Marks that do fit are written *above* the question so the model still sees
 * the ask last.
 */
export function assembleAskPrompt(input: AssembleAskPromptInput): AssembleAskPromptResult {
  const budget = Math.max(0, input.budget);
  const asked = input.question.trim();
  const quote = input.quote?.trim() ?? "";
  let questionTruncated = false;
  let core = coreAskText(asked, quote);

  if (core.length > budget) {
    const prefix = "From the document:\n\n“";
    const suffix = `”\n\n${asked}`;
    const wrapping = prefix.length + suffix.length;
    if (asked.length >= budget) {
      core = `${asked.slice(0, Math.max(0, budget - 14))}\n…(truncated)`;
      questionTruncated = true;
    } else if (quote && wrapping < budget) {
      const room = budget - wrapping;
      core = coreAskText(asked, quote.slice(0, room));
    } else {
      core = asked.slice(0, budget);
      questionTruncated = asked.length > budget;
    }
  }

  const marks = input.marks ?? [];
  if (marks.length === 0 || core.length >= budget) {
    return {
      prompt: core,
      includedMarkIds: [],
      omittedMarkIds: marks.map((mark) => mark.id),
      questionTruncated,
    };
  }

  const room = budget - core.length - 2;
  const packed = packFootnoteContext(marks, {
    numbers: input.numbers,
    budget: room,
    threadTitles: input.threadTitles,
    omitOverflow: true,
  });
  const includedMarkIds = packed ? includedIdsFromPack(packed, marks, input.numbers) : [];
  const includedSet = new Set(includedMarkIds);
  return {
    prompt: packed ? `${packed}\n\n${core}` : core,
    includedMarkIds,
    omittedMarkIds: marks.filter((mark) => !includedSet.has(mark.id)).map((mark) => mark.id),
    questionTruncated,
  };
}
