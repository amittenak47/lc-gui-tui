import { describe, expect, it } from "vitest";

import type { DocFootnote } from "../util/docFootnotes";
import {
  dedupeFootnoteThreads,
  formatFootnoteContext,
  packFootnoteContext,
  assembleAskPrompt,
} from "./coachMarkContext";

function mark(partial: Partial<DocFootnote> & Pick<DocFootnote, "id">): DocFootnote {
  return {
    kind: "note",
    anchor: { kind: "text", start: 0, end: 4 },
    excerpt: "hello",
    createdAt: 1,
    ...partial,
  };
}

describe("coachMarkContext", () => {
  it("packs text, links, notes, and threads for one mark", () => {
    const footnote = mark({
      id: "a",
      blockText: "full block text",
      userLinks: [{ url: "https://example.com", title: "Example" }],
      notes: [{ id: "n1", text: "remember this", createdAt: 1, updatedAt: 1 }],
      threads: [{ rootId: "t1", title: "Earlier ask", createdAt: 1 }],
    });
    const text = formatFootnoteContext(footnote, 3);
    expect(text).toContain("Mark 3");
    expect(text).toContain("full block text");
    expect(text).toContain("Example — https://example.com");
    expect(text).toContain("remember this");
    expect(text).toContain("Earlier ask [t1]");
  });

  it("dedupes thread roots across marks", () => {
    const a = mark({
      id: "a",
      threads: [{ rootId: "t1", title: "One", createdAt: 1 }],
    });
    const b = mark({
      id: "b",
      excerpt: "other",
      threads: [
        { rootId: "t1", title: "One again", createdAt: 2 },
        { rootId: "t2", title: "Two", createdAt: 3 },
      ],
    });
    const threads = dedupeFootnoteThreads([a, b]);
    expect(threads.map((thread) => thread.rootId)).toEqual(["t1", "t2"]);
    expect(threads[0]?.title).toBe("One");
  });

  it("emits shared threads once when packing many marks", () => {
    const a = mark({
      id: "a",
      threads: [{ rootId: "t1", title: "Shared", createdAt: 1 }],
    });
    const b = mark({
      id: "b",
      excerpt: "second",
      threads: [{ rootId: "t1", title: "Shared", createdAt: 1 }],
    });
    const packed = packFootnoteContext([a, b], {
      numbers: new Map([
        ["a", 1],
        ["b", 2],
      ]),
    });
    expect(packed).toContain("Mark 1");
    expect(packed).toContain("Mark 2");
    expect(packed).toContain("deduped across marks");
    expect(packed.match(/\[t1\]/g)?.length).toBe(1);
  });
});

describe("assembleAskPrompt", () => {
  it("puts the question after marks and keeps it when marks would overflow", () => {
    const marks = Array.from({ length: 8 }, (_, index) =>
      mark({
        id: `m${index}`,
        excerpt: "x".repeat(400),
        blockText: "x".repeat(400),
      }),
    );
    const asked = "What is the invariant?";
    const assembled = assembleAskPrompt({
      question: asked,
      quote: "A graph is undirected.",
      marks,
      numbers: new Map(marks.map((entry, index) => [entry.id, index + 1])),
      budget: 1200,
    });
    expect(assembled.prompt.endsWith(asked)).toBe(true);
    expect(assembled.prompt).toContain("A graph is undirected.");
    expect(assembled.includedMarkIds.length).toBeGreaterThan(0);
    expect(assembled.omittedMarkIds.length).toBeGreaterThan(0);
    expect(assembled.prompt.length).toBeLessThanOrEqual(1200);
    expect(assembled.questionTruncated).toBe(false);
  });

  it("truncates an oversize question and reports it", () => {
    const asked = "Q".repeat(200);
    const assembled = assembleAskPrompt({
      question: asked,
      budget: 80,
    });
    expect(assembled.questionTruncated).toBe(true);
    expect(assembled.prompt.length).toBeLessThanOrEqual(80);
    expect(assembled.prompt).toContain("truncated");
  });

  it("omits a whole mark rather than condensing it when omitOverflow is on", () => {
    const packed = packFootnoteContext(
      [
        mark({ id: "a", excerpt: "short" }),
        mark({ id: "b", excerpt: "y".repeat(800), blockText: "y".repeat(800) }),
      ],
      { numbers: new Map([["a", 1], ["b", 2]]), budget: 200, omitOverflow: true },
    );
    expect(packed).toContain("Mark 1");
    expect(packed).not.toContain("Mark 2");
  });
});
