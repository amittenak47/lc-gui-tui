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
 * A marquee mark: a box against its own page, plus the bands it was drawn at.
 *
 * The bands are body-local — a distance down the whole stack — which is what
 * makes them useless to a pane that lays the same book out narrower.
 */
const REGION_MARK: DocFootnote = {
  id: "region",
  kind: "note",
  anchor: { kind: "region", scope: "p6", x: 160.6, y: 120.4, w: 165.7, h: 60.8 },
  excerpt: "Contents",
  createdAt: 1,
  bands: [{ left: 179, top: 4313, width: 117, height: 27 }],
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

describe("marks made on a wider copy of the same page", () => {
  /**
   * One page, laid out at half the width the mark was drawn at.
   *
   * jsdom measures nothing, so the boxes are stated: a body whose page 6 sits
   * 2305px down, which is where a pane scrolled to that page would have it.
   */
  function mountScaled(markScale: number) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <DocSelectionLayer
          enabled={false}
          placeExisting
          markScale={markScale}
          footnotes={[REGION_MARK]}
        >
          <div data-doc-scope="p6" />
        </DocSelectionLayer>,
      ),
    );
    const body = host.querySelector("[data-doc-scope=p6]")!.parentElement as HTMLElement;
    const page = host.querySelector("[data-doc-scope=p6]") as HTMLElement;
    Object.defineProperty(body, "offsetWidth", { value: 347, configurable: true });
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 347, bottom: 4000, width: 347, height: 4000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    page.getBoundingClientRect = () =>
      ({ left: 0, top: 2305, right: 347, bottom: 2740, width: 347, height: 435, x: 0, y: 2305, toJSON: () => ({}) }) as DOMRect;
    return { host, root, body, page };
  }

  it("brings a region anchor across in proportion", () => {
    /*
     * The anchor is x/y against its own page, so it is portable — but only in
     * proportion. Unscaled, a box drawn on a 642px page lands half a page to
     * the right on a 347px one.
     */
    const { host, root, body, page } = mountScaled(347 / 642);
    // Nudge a re-place now that the boxes answer.
    act(() => {
      page.append(document.createElement("span"));
    });
    const band = host.querySelector(".lc-doc-footnote-band") as HTMLElement | null;
    expect(band).not.toBeNull();
    const left = parseFloat(band!.style.left);
    const top = parseFloat(band!.style.top);
    /*
     * 160.6 and 120.4 scaled by 0.5405 — 86.8 and 65.1 — then padded out a
     * few px the way every quote box is. On the device this lands at 83.3 / 62
     * inside its page, with the word "Contents" at 96.7 / 75.3 inside the box.
     *
     * jsdom reports a zero offset for the page within the body whatever it is
     * told, so this pins the part that was wrong — the scale — and the page
     * offset is what the device run checks.
     */
    const width = parseFloat(band!.style.width);
    const height = parseFloat(band!.style.height);
    expect(left).toBeCloseTo(83.3, 0);
    expect(top).toBeCloseTo(59.2, 0);
    // Unscaled, this box would be 165.7 wide on a page only 347 across.
    expect(width).toBeLessThan(120);
    expect(width).toBeGreaterThan(80);
    expect(height).toBeLessThan(50);
    expect(body).toBeTruthy();
    act(() => root.unmount());
  });

  it("does not reuse bands recorded in the other layout", () => {
    /*
     * Those bands put this mark at 4313 down a stack whose page 6 starts at
     * 2305 — four pages below the words. They are ignored under
     * `placeExisting`, and the anchor answers instead.
     */
    const { host, root, page } = mountScaled(347 / 642);
    act(() => {
      page.append(document.createElement("span"));
    });
    const band = host.querySelector(".lc-doc-footnote-band") as HTMLElement;
    expect(parseFloat(band.style.top)).toBeLessThan(4313);
    act(() => root.unmount());
  });
});
