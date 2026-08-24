/**
 * Editing an owned note's markdown source.
 *
 * Only owned notes reach here — the ones New file made, where `content.source`
 * *is* the document. Imported files never do: their entry holds a copy kept
 * for reopening, and writing to it would break the promise the whole annotate
 * library is built on.
 *
 * A textarea in the paper slot — the same camera-transformed box as preview,
 * under Excalidraw, not over it. Monaco stays on code pads; a second
 * contenteditable / IDE canvas on this slot fights Scroll vs Annotate.
 */

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

import { shouldReportDocumentHeight } from "./AnnotateDocument";
import type { BoardReadingSize } from "./codeFontSize";
import { BODY_FONT_PX } from "./codeFontSize";

export interface AnnotateMarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  readingSize?: BoardReadingSize;
  /**
   * The editor's laid-out height, so the board page can grow to it.
   *
   * Same contract as the paper's `onMeasure`: the page frame has to cover the
   * whole document or its last lines sit outside the page.
   */
  onMeasure?: (height: number) => void;
}

export type MdFormatKind =
  | "heading"
  | "bold"
  | "italic"
  | "list"
  | "quote"
  | "task"
  | "link"
  | "fence";

export interface AnnotateMarkdownEditorHandle {
  format: (kind: MdFormatKind) => void;
}

/** The fence a reader gets from Insert code block, when nothing says otherwise. */
export const DEFAULT_FENCE_LANGUAGE = "python";

/** New file seeds `# Title` — that is still a note with nothing to preview. */
export function isFreshOwnedNote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return /^# [^\n]+$/.test(trimmed);
}

/**
 * Put a fenced block at the cursor, and say where the cursor should end up.
 *
 * Returned rather than applied so the caller owns the buffer — and so this is
 * testable without an editor. The offset points *inside* the fence, because
 * landing the reader on the closing backticks would make them navigate out of
 * the thing they just asked for.
 */
export function insertFence(
  source: string,
  at: number,
  language = DEFAULT_FENCE_LANGUAGE,
): { source: string; cursor: number } {
  const cut = Math.max(0, Math.min(at, source.length));
  const before = source.slice(0, cut);
  const after = source.slice(cut);
  // Only add the separating newlines that are not already there, so repeated
  // inserts do not walk the block down the page.
  const lead = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after.startsWith("\n") || after.length === 0 ? "" : "\n";
  const block = `\`\`\`${language}\n\n\`\`\`\n`;
  return {
    source: `${before}${lead}${block}${tail}${after}`,
    cursor: before.length + lead.length + language.length + 4,
  };
}

function clampRange(source: string, start: number, end: number): { start: number; end: number } {
  const a = Math.max(0, Math.min(start, source.length));
  const b = Math.max(0, Math.min(end, source.length));
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function wrapInline(
  source: string,
  start: number,
  end: number,
  mark: string,
): { source: string; cursor: number } {
  const range = clampRange(source, start, end);
  const inner = source.slice(range.start, range.end) || "text";
  const next = `${source.slice(0, range.start)}${mark}${inner}${mark}${source.slice(range.end)}`;
  return { source: next, cursor: range.start + mark.length + inner.length };
}

function prefixCurrentLine(
  source: string,
  at: number,
  prefix: string,
): { source: string; cursor: number } {
  const cut = Math.max(0, Math.min(at, source.length));
  const lineStart = source.lastIndexOf("\n", cut - 1) + 1;
  if (source.slice(lineStart).startsWith(prefix)) {
    return { source, cursor: cut };
  }
  const next = `${source.slice(0, lineStart)}${prefix}${source.slice(lineStart)}`;
  return { source: next, cursor: cut + prefix.length };
}

export function applyMdFormat(
  source: string,
  start: number,
  end: number,
  kind: MdFormatKind,
): { source: string; cursor: number } {
  const range = clampRange(source, start, end);
  if (kind === "bold") return wrapInline(source, range.start, range.end, "**");
  if (kind === "italic") return wrapInline(source, range.start, range.end, "*");
  if (kind === "heading") return prefixCurrentLine(source, range.start, "# ");
  if (kind === "list") return prefixCurrentLine(source, range.start, "- ");
  if (kind === "quote") return prefixCurrentLine(source, range.start, "> ");
  if (kind === "task") return prefixCurrentLine(source, range.start, "- [ ] ");
  if (kind === "link") {
    /*
     * The URL is where the cursor lands, not the text.
     *
     * Selected words become the label — they are already the thing being linked
     * — and what is missing afterwards is always the address, so that is what
     * the caret should be sitting in.
     */
    const label = source.slice(range.start, range.end) || "text";
    const next = `${source.slice(0, range.start)}[${label}](url)${source.slice(range.end)}`;
    const urlAt = range.start + label.length + 3;
    return { source: next, cursor: urlAt };
  }
  return insertFence(source, range.start);
}

export const AnnotateMarkdownEditor = forwardRef<
  AnnotateMarkdownEditorHandle,
  AnnotateMarkdownEditorProps
>(function AnnotateMarkdownEditor(
  { value, onChange, readingSize = "M", onMeasure },
  ref,
) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(ref, () => ({
    format(kind) {
      const node = areaRef.current;
      /*
       * A caret the reader has not placed is at the end, not at zero.
       *
       * `selectionStart` is 0 on a textarea nobody has touched, so every format
       * button inserted its marks in front of the first character — press bold
       * twice before typing and the note began `****# Untitled`. Nobody means
       * "before the title"; they mean "here, where I am about to write".
       */
      const touched = node != null && document.activeElement === node;
      const start = touched ? node.selectionStart : value.length;
      const end = touched ? node.selectionEnd : start;
      const next = applyMdFormat(value, start, end, kind);
      onChange(next.source);
      requestAnimationFrame(() => {
        const live = areaRef.current;
        if (!live) return;
        live.focus();
        live.setSelectionRange(next.cursor, next.cursor);
      });
    },
  }));

  /*
   * Entering Edit puts the caret in the note.
   *
   * Otherwise the reader is looking at a page with no visible caret and no
   * obvious place to press — the paper and the editor are the same colour, so
   * "where do I type" has no answer until something happens to focus it.
   */
  useLayoutEffect(() => {
    const node = areaRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, []);

  useLayoutEffect(() => {
    const node = areaRef.current;
    if (!node) return;
    node.style.height = "0px";
    /*
     * At least a pane's worth of paper, however little is written on it.
     *
     * A short note left a short box on a tall page, so pressing below the last
     * line missed the note entirely. `min-height: 100%` cannot help — the slot's
     * own height is auto, so the percentage has nothing to resolve against.
     *
     * The slot is CSS-scaled by the board camera, so the pane's pixels are not
     * the page's units. Width gives the conversion: it is not being changed
     * here, so its rendered-over-laid-out ratio *is* the current scale.
     */
    const laidOutWidth = node.offsetWidth;
    const scale =
      laidOutWidth > 0 ? node.getBoundingClientRect().width / laidOutWidth : 1;
    const board = node.closest(".lc-board");
    const paneHeight =
      board instanceof HTMLElement && scale > 0.01
        ? Math.round(board.clientHeight / scale)
        : 0;
    const next = Math.max(node.scrollHeight, paneHeight, 280);
    node.style.height = `${next}px`;
    if (!shouldReportDocumentHeight(node.clientWidth, Boolean(value.trim()))) return;
    onMeasure?.(next);
  }, [onMeasure, value]);

  const textProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    className: "lc-md-edit-area",
    value,
    spellCheck: true,
    "aria-label": "Note source",
    style: { fontSize: BODY_FONT_PX[readingSize] },
    onChange: (event) => onChange(event.target.value),
  };

  return (
    <div className="lc-md-edit-host">
      <textarea ref={areaRef} {...textProps} />
    </div>
  );
});
