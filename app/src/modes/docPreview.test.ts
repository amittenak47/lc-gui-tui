/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import {
  DOC_PARSE_INLINE_MAX_CHARS,
  DOC_PREVIEW_MAX_CHARS,
  docPreview,
  parseInline,
  truncationNoticeHtml,
} from "./docPreview";
import { renderMarkdown } from "./AnnotateDocument";
import { renderCode } from "./CodeDocument";
import { CODE_SOURCE_MAX_CHARS } from "../util/codeLanguages";

describe("docPreview", () => {
  it("leaves an ordinary document entirely alone", () => {
    const source = "# Notes\n\nA paragraph.\n";
    expect(docPreview(source)).toEqual({ text: source, hidden: 0 });
  });

  it("draws the beginning of a file too long to lay out", () => {
    // The accepted source limit is 1.5M characters, and the page has no inner
    // scroller — the whole file becomes DOM at full content height.
    const source = "x".repeat(DOC_PREVIEW_MAX_CHARS * 3);
    const preview = docPreview(source);
    expect(preview.text.length).toBeLessThanOrEqual(DOC_PREVIEW_MAX_CHARS);
    expect(preview.hidden).toBe(source.length - preview.text.length);
  });

  it("cuts at a line break so the last drawn line is a whole one", () => {
    const line = `${"a".repeat(99)}\n`;
    const source = line.repeat(Math.ceil((DOC_PREVIEW_MAX_CHARS * 2) / line.length));
    const preview = docPreview(source);
    expect(preview.text.endsWith("a")).toBe(true);
    expect(source[preview.text.length]).toBe("\n");
  });

  it("falls back to a hard cut when there is no line break to use", () => {
    const source = "x".repeat(DOC_PREVIEW_MAX_CHARS * 2);
    expect(docPreview(source).text).toHaveLength(DOC_PREVIEW_MAX_CHARS);
  });
});

describe("parseInline", () => {
  it("keeps ordinary notes on the render path", () => {
    expect(parseInline("# Hello")).toBe(true);
    expect(parseInline("x".repeat(DOC_PARSE_INLINE_MAX_CHARS))).toBe(true);
  });

  it("moves a large one off it", () => {
    expect(parseInline("x".repeat(DOC_PARSE_INLINE_MAX_CHARS + 1))).toBe(false);
  });
});

describe("truncationNoticeHtml", () => {
  it("says nothing when the whole file is on the page", () => {
    expect(truncationNoticeHtml(0)).toBe("");
    expect(truncationNoticeHtml(-1)).toBe("");
  });

  it("says the text is still stored, only not drawn", () => {
    const notice = truncationNoticeHtml(120_000);
    expect(notice).toContain("120k more characters");
    expect(notice).toContain("searchable");
  });
});

describe("rendering a document that is too long to draw", () => {
  it("markdown: draws the beginning and says so", () => {
    const source = `# Title\n\n${"word ".repeat(DOC_PREVIEW_MAX_CHARS)}`;
    const html = renderMarkdown(source);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("lc-doc-truncated");
    expect(html.length).toBeLessThan(source.length);
  });

  it("markdown: an ordinary note gets no notice", () => {
    expect(renderMarkdown("# Title\n\nBody.")).not.toContain("lc-doc-truncated");
  });

  it("code: escapes only what it draws", () => {
    const source = `${"<script>\n".repeat(DOC_PREVIEW_MAX_CHARS)}`;
    const html = renderCode(source, "js");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("lc-doc-truncated");
  });

  it("code: an ordinary file gets no notice", () => {
    expect(renderCode("const a = 1;\n", "ts")).not.toContain("lc-doc-truncated");
  });
});

describe("80k draw cap against real-shaped files", () => {
  const sentence =
    "The pad writes locally first, then the hub takes a copy of what landed. ";

  it("draws a long notes file in full (under the cap)", () => {
    // ~11k words, typical lecture notes / a long working file — not a book.
    const source = `# Lecture notes\n\n${sentence.repeat(800)}`;
    expect(source.length).toBeLessThan(DOC_PREVIEW_MAX_CHARS);
    const preview = docPreview(source);
    expect(preview.hidden).toBe(0);
    expect(preview.text).toBe(source);
    expect(renderMarkdown(source)).not.toContain("lc-doc-truncated");
  });

  it("draws only the beginning of a book-length markdown file", () => {
    const chapters: string[] = [];
    let length = 0;
    let n = 1;
    while (length < CODE_SOURCE_MAX_CHARS) {
      const chapter = `# Chapter ${n}\n\n${sentence.repeat(80)}\n`;
      chapters.push(chapter);
      length += chapter.length;
      n += 1;
    }
    const source = chapters.join("").slice(0, CODE_SOURCE_MAX_CHARS);
    const preview = docPreview(source);
    expect(preview.text.length).toBeLessThanOrEqual(DOC_PREVIEW_MAX_CHARS);
    expect(preview.hidden).toBeGreaterThan(source.length * 0.9);
    const html = renderMarkdown(source);
    expect(html).toContain("lc-doc-truncated");
    expect(html).toContain("<h1>Chapter 1</h1>");
  });
});
