/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { FootnoteOverview } from "./FootnoteOverview";

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.textContent = "";
});

function mount(onCreateWhiteboard?: () => void) {
  const onChange = vi.fn();
  const onOpenWhiteboard = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(
    <FootnoteOverview
      footnote={{ id: "f1", kind: "note", anchor: { kind: "text", start: 0, end: 4 }, excerpt: "test", createdAt: 1 }}
      onChange={onChange} onClose={() => {}} threadMessages={() => []}
      onSendCoach={() => {}} onOpenExternal={() => {}}
      subMarkMode={null} onSubMarkModeChange={() => {}}
      onCreateWhiteboard={onCreateWhiteboard} onOpenWhiteboard={onOpenWhiteboard}
    />,
  ));
  onChange.mockClear();
  return { onChange, onOpenWhiteboard };
}

describe("scratch-board creation", () => {
  it("asks the owner to persist content instead of publishing a dangling pointer", () => {
    const create = vi.fn();
    const { onChange, onOpenWhiteboard } = mount(create);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Add Whiteboards"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(create).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpenWhiteboard).not.toHaveBeenCalled();
  });

  it("does not offer creation without an owner capable of saving the scene", () => {
    mount();
    expect(document.querySelector('button[aria-label="Add Whiteboards"]')).toBeNull();
  });
});
