/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { DocSelectionLayer } from "./DocSelectionLayer";
import type { DocFootnote } from "../util/docFootnotes";

const MARK: DocFootnote = {
  id: "same",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 8, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
};

/**
 * A page whose text arrives after mount, which is what a PDF does.
 *
 * The first `place()` runs against an empty scope root and finds nothing to
 * measure. Whether the mark ever appears comes down to whether the layer is
 * still watching when the text layer lands.
 */
function mountLayer(props: { placeExisting?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DocSelectionLayer
        enabled={false}
        placeExisting={props.placeExisting}
        footnotes={[MARK]}
      >
        <div data-doc-scope="p6" />
      </DocSelectionLayer>,
    ),
  );
  return { host, root };
}

function landText(host: HTMLElement) {
  const scope = host.querySelector('[data-doc-scope="p6"]')!;
  const span = document.createElement("span");
  span.textContent = "Contents";
  act(() => {
    scope.append(span);
  });
}

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("placeExisting", () => {
  it("watches for the text layer, which the reader deliberately does not", () => {
    /*
     * `enabled` arms the selection gestures, and the conflict panes must not
     * have those — their whole job is to be scrolled. The reader keeps the
     * layer mounted with `enabled={false}` and no watching on purpose, because
     * re-placing ribbons on every window mutation mid-flick starves ink paint
     * until scroll settle. So this is opt-in, and separate from both.
     */
    const observe = vi.spyOn(MutationObserver.prototype, "observe");

    const off = mountLayer({});
    const withoutWatching = observe.mock.calls.length;
    act(() => off.root.unmount());

    observe.mockClear();
    const on = mountLayer({ placeExisting: true });
    landText(on.host);

    expect(withoutWatching).toBe(0);
    expect(observe.mock.calls.length).toBeGreaterThan(0);
    act(() => on.root.unmount());
  });

  it("leaves selection off, so the pane still scrolls", () => {
    // `placeExisting` is placement only — no marquee, no new marks.
    const { host, root } = mountLayer({ placeExisting: true });
    expect(host.querySelector(".lc-doc-marquee-band")).toBeNull();
    act(() => root.unmount());
  });
});
