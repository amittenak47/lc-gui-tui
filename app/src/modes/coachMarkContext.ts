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

export interface PackFootnoteContextOptions {
  numbers?: ReadonlyMap<string, number>;
  budget?: number;
  /**
   * Known thread titles keyed by rootId — when the mark only stored a rootId,
   * the live coach transcript can fill the title.
   */
  threadTitles?: ReadonlyMap<string, string>;
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
