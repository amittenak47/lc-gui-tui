import { describe, expect, it } from "vitest";

import {
  CODE_SOURCE_MAX_CHARS,
  languageForName,
} from "./codeLanguages";
import {
  buildAnnotateSidecar,
  DOCUMENT_ACCEPT,
  docTypeForName,
  isMarkdownName,
  isTextDocType,
  readAnnotateSidecar,
} from "./annotateFs";
import type { BoardBlob } from "../canvas/BoardHandle";
import { encodeInkOps, inkOpsFrom } from "../canvas/inkCodec";
import type { InkDrawOp } from "../canvas/rasterInk";

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
  it("is true for markdown, code, and captured web pages", () => {
    expect(isTextDocType("markdown")).toBe(true);
    expect(isTextDocType("code")).toBe(true);
    expect(isTextDocType("pdf")).toBe(false);
    expect(isTextDocType("epub")).toBe(false);
    expect(isTextDocType("web")).toBe(true);
  });
});

describe("CODE_SOURCE_MAX_CHARS", () => {
  it("is a practical soft ceiling around 1.5MB of characters", () => {
    expect(CODE_SOURCE_MAX_CHARS).toBe(1_500_000);
  });
});

describe("sidecar round trip", () => {
  /*
   * Nothing anywhere put real ink through build → JSON → read, which is how a
   * sidecar carrying encoded ink could have shipped decoding to a single point
   * on every stroke. The file is the one place ink crosses `JSON.stringify`
   * without IndexedDB's structured clone underneath it, so a typed array comes
   * back as `{"0":…,"1":…}` unless something reattaches it.
   */
  function inkedBoard(): BoardBlob {
    const points = [];
    let x = 640.1928100585938;
    let y = 312.4111328125;
    for (let i = 0; i < 40; i += 1) {
      x += 1.2;
      y += 0.8;
      points.push({ x, y, pressure: 0.42 + i * 0.001, slowness: 0.51 });
    }
    return {
      v: 1,
      elements: [],
      appState: { scrollX: 0, scrollY: 0, zoom: 1 },
      inkC: encodeInkOps([
        {
          kind: "draw",
          color: "#1b1f24",
          baseWidth: 2,
          maxFullness: 0.8,
          pressureClip: 0.6,
          pressureSensitive: true,
          points,
        },
      ]),
    };
  }

  it("brings the handwriting back through the file", () => {
    const sidecar = buildAnnotateSidecar({
      sourceName: "notes.md",
      contentHash: "md1-1",
      board: inkedBoard(),
    });
    const parsed = readAnnotateSidecar(JSON.stringify(sidecar));
    expect(parsed).not.toBeNull();
    const ops = inkOpsFrom(parsed!.board) as InkDrawOp[];
    expect(ops).toHaveLength(1);
    expect(ops[0].points).toHaveLength(40);
    // The last point is the one that proves the deltas were rebuilt: an
    // unrevived typed array yields NaN from the second point onwards.
    expect(ops[0].points[39].x).toBeCloseTo(640.1928100585938 + 1.2 * 40, 1);
    expect(ops[0].points[39].y).toBeCloseTo(312.4111328125 + 0.8 * 40, 1);
    expect(Number.isFinite(ops[0].points[39].x)).toBe(true);
  });

  it("still reads a sidecar written before the codec", () => {
    const legacy = buildAnnotateSidecar({
      sourceName: "notes.md",
      contentHash: "md1-1",
      board: {
        v: 1,
        elements: [],
        appState: { scrollX: 0, scrollY: 0, zoom: 1 },
        ink: [
          {
            kind: "draw",
            color: "#000",
            baseWidth: 2,
            maxFullness: 1,
            pressureClip: 1,
            pressureSensitive: false,
            points: [{ x: 1, y: 2, pressure: -1 }],
          },
        ],
      },
    });
    const parsed = readAnnotateSidecar(JSON.stringify(legacy));
    const ops = inkOpsFrom(parsed!.board) as InkDrawOp[];
    expect(ops[0].points[0]).toEqual({ x: 1, y: 2, pressure: -1 });
  });

  it("keeps footnotes across the file", () => {
    const sidecar = buildAnnotateSidecar({
      sourceName: "notes.md",
      contentHash: "md1-1",
      board: inkedBoard(),
      footnotes: [
        {
          id: "fn1",
          kind: "coach",
          anchor: { kind: "text", start: 10, end: 20 },
          excerpt: "a passage",
          createdAt: 1,
          threadRootId: "m1",
        },
      ],
    });
    const parsed = readAnnotateSidecar(JSON.stringify(sidecar));
    expect(parsed!.footnotes).toHaveLength(1);
    expect(parsed!.footnotes![0].excerpt).toBe("a passage");
  });

  it("refuses something that is not a sidecar", () => {
    expect(readAnnotateSidecar("{}")).toBeNull();
    expect(readAnnotateSidecar("not json")).toBeNull();
  });
});
