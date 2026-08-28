/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { FootnoteOverview } from "./FootnoteOverview";
import type { DocFootnote } from "../util/docFootnotes";

const MARK: DocFootnote = {
  id: "same",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 4, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
  notes: [{ id: "n1", text: "a note that is already here", createdAt: 1, updatedAt: 1 }],
  whiteboards: [{ id: "wb1", title: "scratch", createdAt: 1, updatedAt: 1 }],
};

function mount(readOnly: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  act(() =>
    root.render(
      <FootnoteOverview
        footnote={MARK}
        readOnly={readOnly}
        onChange={onChange}
        onClose={() => {}}
        threadMessages={() => []}
        onSendCoach={() => {}}
        onOpenExternal={() => {}}
        subMarkMode={null}
        onSubMarkModeChange={() => {}}
      />,
    ),
  );
  return { root, onChange };
}

function addButtons() {
  return Array.from(document.querySelectorAll(".lc-footnote-overview-add"));
}

afterEach(() => {
  document.body.textContent = "";
});

describe("FootnoteOverview readOnly", () => {
  it("still shows what the mark holds", () => {
    /*
     * The conflict split mounts one of these per pane. Hiding the contents
     * would defeat the point — the reader is comparing two copies of the same
     * mark, and the difference is exactly what is in them.
     */
    mount(true);
    const text = document.body.textContent ?? "";
    expect(text).toContain("a note that is already here");
    expect(text).toContain("scratch");
  });

  it("offers nothing that would write to it", () => {
    // Keep is the only write in that flow; a note added to the copy that is
    // about to lose would be thrown away without saying so.
    mount(true);
    expect(addButtons()).toHaveLength(0);
    expect(document.querySelector('[aria-label="Underline"]')).toBeNull();
  });

  it("names the title without offering to rename it", () => {
    mount(true);
    const title = document.querySelector(".lc-footnote-overview-title-display");
    expect(title?.getAttribute("aria-label")).toBe("Mark title");
  });

  it("is the writable card everywhere else", () => {
    mount(false);
    expect(addButtons().length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-label="Underline"]')).not.toBeNull();
  });
});
