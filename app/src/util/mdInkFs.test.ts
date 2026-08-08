import { describe, expect, it } from "vitest";

import {
  CODE_SOURCE_MAX_CHARS,
  languageForName,
} from "./codeLanguages";
import {
  DOCUMENT_ACCEPT,
  docTypeForName,
  isMarkdownName,
  isTextDocType,
} from "./mdInkFs";

describe("docTypeForName", () => {
  it("classifies markdown by extension", () => {
    expect(docTypeForName("notes.md")).toBe("markdown");
    expect(docTypeForName("NOTES.Markdown")).toBe("markdown");
    expect(docTypeForName("a.mdown")).toBe("markdown");
  });

  it("classifies pdf and epub", () => {
    expect(docTypeForName("book.pdf")).toBe("pdf");
    expect(docTypeForName("novel.EPUB")).toBe("epub");
  });

  it("classifies common source extensions as code", () => {
    expect(docTypeForName("main.py")).toBe("code");
    expect(docTypeForName("App.tsx")).toBe("code");
    expect(docTypeForName("lib.rs")).toBe("code");
    expect(docTypeForName("main.go")).toBe("code");
    expect(docTypeForName("Main.java")).toBe("code");
    expect(docTypeForName("script.sh")).toBe("code");
  });

  it("opens .txt as code, not markdown", () => {
    expect(docTypeForName("readme.txt")).toBe("code");
    expect(isMarkdownName("readme.txt")).toBe(false);
  });

  it("opens unknown extensions as code", () => {
    expect(docTypeForName("weird.xyz")).toBe("code");
    expect(docTypeForName("noext")).toBe("code");
  });

  it("recognises special basenames as code", () => {
    expect(docTypeForName("Dockerfile")).toBe("code");
    expect(docTypeForName("Makefile")).toBe("code");
    expect(docTypeForName("path/to/Gemfile")).toBe("code");
  });
});

describe("languageForName", () => {
  it("maps extensions to language ids", () => {
    expect(languageForName("a.py")).toBe("python");
    expect(languageForName("a.ts")).toBe("typescript");
    expect(languageForName("a.rs")).toBe("rust");
  });

  it("maps special basenames", () => {
    expect(languageForName("Dockerfile")).toBe("dockerfile");
    expect(languageForName("Makefile")).toBe("makefile");
  });

  it("falls back to plaintext", () => {
    expect(languageForName("weird.xyz")).toBe("plaintext");
  });
});

describe("DOCUMENT_ACCEPT", () => {
  it("includes markdown, pdf, epub, and common code extensions", () => {
    expect(DOCUMENT_ACCEPT).toContain(".md");
    expect(DOCUMENT_ACCEPT).toContain(".pdf");
    expect(DOCUMENT_ACCEPT).toContain(".epub");
    expect(DOCUMENT_ACCEPT).toContain(".py");
    expect(DOCUMENT_ACCEPT).toContain(".rs");
    expect(DOCUMENT_ACCEPT).toContain(".ts");
  });
});

describe("isTextDocType", () => {
  it("is true for markdown and code only", () => {
    expect(isTextDocType("markdown")).toBe(true);
    expect(isTextDocType("code")).toBe(true);
    expect(isTextDocType("pdf")).toBe(false);
    expect(isTextDocType("epub")).toBe(false);
  });
});

describe("CODE_SOURCE_MAX_CHARS", () => {
  it("is a practical soft ceiling around 1.5MB of characters", () => {
    expect(CODE_SOURCE_MAX_CHARS).toBe(1_500_000);
  });
});
