/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { DocSelectionLayer } from "./DocSelectionLayer";
import type { DocFootnote } from "../util/docFootnotes";
import type { PageFrame } from "../canvas/inkPageIndex";
import { publishDocPlacementRev, publishPdfViewPages, resetPdfFilmScopes } from "./pdfFilm";
import { makeDocFlagHolds, resetDocCameraForTests } from "../canvas/docSelectionGesture";

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

const PAGE1_MARK: DocFootnote = {
  id: "page1",
  kind: "note",
  anchor: { kind: "region", scope: "p1", x: 20, y: 20, w: 40, h: 18 },
  excerpt: "Title",
  createdAt: 1,
};

/**
 * A page whose text arrives after mount, which is what a PDF does.
 *
 * The first `place()` runs against an empty scope root and finds nothing to
 * measure. Whether the mark ever appears comes down to whether the layer is
 * still watching when the text layer lands.
 */
function mountLayer(props: { placeExisting?: boolean; paletteScope?: string }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DocSelectionLayer
        enabled={false}
        placeExisting={props.placeExisting}
        paletteScope={props.paletteScope}
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  document.body.textContent = "";
  resetPdfFilmScopes();
  resetDocCameraForTests();
  vi.unstubAllGlobals();
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
  function mountScaled(
    markScale: number,
    paletteScope = "",
    footnotes: readonly DocFootnote[] = [REGION_MARK],
    pdf = paletteScope !== "",
    markPageFrames?: readonly PageFrame[],
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const pageEl = (scope: string, pdfPage?: number) => (
      <div
        data-doc-scope={scope}
        {...(pdfPage != null ? { "data-pdf-page": String(pdfPage) } : {})}
      />
    );
    const tree = (notes: readonly DocFootnote[]) => (
      <DocSelectionLayer
        enabled={false}
        placeExisting
        markScale={markScale}
        markPageFrames={markPageFrames}
        paletteScope={paletteScope}
        footnotes={notes}
      >
        {pdf ? pageEl("p1", 1) : null}
        {pageEl("p6", pdf ? 6 : undefined)}
      </DocSelectionLayer>
    );
    act(() => root.render(tree(footnotes)));
    const bindBoxes = () => {
      const body = host.querySelector("[data-doc-scope=p6]")!.parentElement as HTMLElement;
      const page = host.querySelector("[data-doc-scope=p6]") as HTMLElement;
      const page1 = host.querySelector("[data-doc-scope=p1]") as HTMLElement | null;
      Object.defineProperty(body, "offsetWidth", { value: 347, configurable: true });
      body.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 347, bottom: 4000, width: 347, height: 4000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 2305, right: 347, bottom: 2740, width: 347, height: 435, x: 0, y: 2305, toJSON: () => ({}) }) as DOMRect;
      if (page1) {
        page1.getBoundingClientRect = () =>
          ({ left: 0, top: 0, right: 347, bottom: 435, width: 347, height: 435, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      }
      return { body, page };
    };
    const { body, page } = bindBoxes();
    return {
      host,
      root,
      body,
      page,
      setFootnotes(notes: readonly DocFootnote[]) {
        act(() => root.render(tree(notes)));
        bindBoxes();
      },
    };
  }

  it("preserves the authored bands relative to their page, excluding earlier page gaps", () => {
    const {host,root,setFootnotes} = mountScaled(0.5,"",[REGION_MARK],false,[{pageId:6,minY:4000,maxY:5000}]);
    setFootnotes([{...REGION_MARK}]);
    const band = host.querySelector<HTMLElement>(".lc-doc-footnote-band")!;
    expect(parseFloat(band.style.left)+parseFloat(band.style.width)/2).toBeCloseTo((179+117/2)*0.5);
    expect(parseFloat(band.style.top)+parseFloat(band.style.height)/2).toBeCloseTo(2305+(4313-4000+27/2)*0.5);
    act(()=>root.unmount());
  });

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

  it("hides a footnote whose PDF page is not in view", () => {
    publishPdfViewPages("tab-1", [1], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("does not remasure on camera settle when the document did not change", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();

    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    const holds = makeDocFlagHolds("tab-1");
    act(() => holds.camera(true));
    act(() => holds.camera(false));
    expect(measured).toBe(0);
    act(() => root.unmount());
  });

  it("places from a renderer revision after a flick, not from settle itself", () => {
    publishPdfViewPages("tab-1", [1], []);
    const holds = makeDocFlagHolds("tab-1");
    act(() => holds.camera(true));
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => holds.camera(false));
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();

    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    act(() => {
      publishDocPlacementRev("tab-1", [6]);
    });
    expect(measured).toBeGreaterThan(0);

    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("drops a deleted mark instead of resurrecting it when its page returns", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page, setFootnotes } = mountScaled(347 / 642, "tab-1", [
      PAGE1_MARK,
      REGION_MARK,
    ]);
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();

    act(() => {
      publishPdfViewPages("tab-1", [1], []);
    });
    setFootnotes([PAGE1_MARK]);
    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => root.unmount());
  });

  it("clears ribbons when the last annotation is removed", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page, setFootnotes } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    setFootnotes([]);
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => root.unmount());
  });

  it("places markdown text that landed during a flick", async () => {
    const holds = makeDocFlagHolds("md-1");
    const { host, root, page } = mountScaled(347 / 642, "md-1", [REGION_MARK], false);
    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    await act(async () => holds.camera(true));
    await act(async () => {
      page.append(document.createElement("span"));
      await Promise.resolve();
    });
    expect(measured).toBe(0);
    await act(async () => holds.camera(false));
    expect(measured).toBeGreaterThan(0);
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("keeps a scheduled PDF placement when a flick starts before the frame runs", async () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    let pending: FrameRequestCallback | null = null;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      pending = cb;
      return 99;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      if (id === 99) pending = null;
    });
    page.append(document.createElement("span"));
    await Promise.resolve();
    expect(pending).not.toBeNull();
    expect(measured).toBe(0);
    const holds = makeDocFlagHolds("tab-1");
    await act(async () => holds.camera(true));
    expect(cancel).toHaveBeenCalledWith(99);
    expect(pending).toBeNull();
    expect(measured).toBe(0);
    raf.mockRestore();
    cancel.mockRestore();
    await act(async () => holds.camera(false));
    expect(measured).toBeGreaterThan(0);
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });
});
