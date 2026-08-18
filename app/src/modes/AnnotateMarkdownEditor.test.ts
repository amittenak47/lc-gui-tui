import { describe, expect, it } from "vitest";

import { DEFAULT_FENCE_LANGUAGE, insertFence } from "./AnnotateMarkdownEditor";

describe("insertFence", () => {
  it("opens a fence and puts the cursor inside it", () => {
    const { source, cursor } = insertFence("", 0);
    expect(source).toBe("```python\n\n```\n");
    // The empty line inside the block, not the closing backticks — otherwise
    // the reader has to navigate out of the thing they just asked for.
    expect(source.slice(0, cursor)).toBe("```python\n");
    expect(source.slice(cursor)).toBe("\n```\n");
  });

  it("uses the language it is given", () => {
    expect(insertFence("", 0, "rust").source.startsWith("```rust\n")).toBe(true);
    expect(DEFAULT_FENCE_LANGUAGE).toBe("python");
  });

  it("separates the block from text already above it", () => {
    expect(insertFence("notes", 5).source).toBe("notes\n\n```python\n\n```\n");
  });

  it("does not stack blank lines that are already there", () => {
    // Repeated inserts would otherwise walk the block down the page.
    expect(insertFence("notes\n\n", 7).source).toBe("notes\n\n```python\n\n```\n");
    expect(insertFence("notes\n", 6).source).toBe("notes\n\n```python\n\n```\n");
  });

  it("keeps whatever followed the cursor", () => {
    const { source } = insertFence("before\n\nafter", 8);
    expect(source).toContain("```python");
    expect(source.endsWith("after")).toBe(true);
  });

  it("clamps a cursor that is outside the text", () => {
    expect(insertFence("abc", 99).source.startsWith("abc\n\n```")).toBe(true);
    expect(insertFence("abc", -5).source.startsWith("```python")).toBe(true);
  });
});
