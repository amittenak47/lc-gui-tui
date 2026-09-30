/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { DOC_PARSE_INLINE_MAX_CHARS, parseInline } from "./docPreview";
import { renderMarkdown } from "./AnnotateDocument";
import { renderCode } from "./CodeDocument";
import { CODE_SOURCE_MAX_CHARS } from "../util/codeLanguages";

describe("parseInline", () => {
  it("keeps ordinary notes on the render path", () => {
    expect(parseInline("# Hello")).toBe(true);
    expect(parseInline("x".repeat(DOC_PARSE_INLINE_MAX_CHARS))).toBe(true);
  });

  it("moves a large one off it", () => {
    expect(parseInline("x".repeat(DOC_PARSE_INLINE_MAX_CHARS + 1))).toBe(false);
  });
});

describe("rendering a book-length document", () => {
  const sentence =
    "The pad writes locally first, then the hub takes a copy of what landed. ";

  it("markdown: draws every chapter, the last one included", () => {
    const chapters: string[] = [];
    let length = 0;
    let n = 1;
    while (length < CODE_SOURCE_MAX_CHARS) {
      const chapter = `# Chapter ${n}\n\n${sentence.repeat(80)}\n`;
      chapters.push(chapter);
      length += chapter.length;
      n += 1;
    }
    const html = renderMarkdown(chapters.join(""));
    expect(html).toContain("<h1>Chapter 1</h1>");
    expect(html).toContain(`<h1>Chapter ${n - 1}</h1>`);
    expect(html).not.toContain("lc-doc-truncated");
  });

  it("code: escapes the whole file", () => {
    const source = "<script>\n".repeat(200_000);
    const html = renderCode(source, "js");
    expect(html).not.toContain("<script>");
    expect(html.split("&lt;script&gt;")).toHaveLength(200_001);
  });
});
