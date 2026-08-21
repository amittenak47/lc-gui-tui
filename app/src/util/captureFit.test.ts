import { describe, expect, it } from "vitest";

import { captureFit, captureFitSummary, captureIsSafe, type FitMark } from "./captureFit";

const textMark = (id: string, exact: string, over = {}): FitMark => ({
  id,
  anchor: { kind: "text", start: 0, end: exact.length, exact, ...over },
});

describe("captureFit", () => {
  it("says an edited article is safe to replace", () => {
    // The page changed around the words; the words are still there.
    const fit = captureFit(
      [textMark("a", "marked words"), textMark("b", "other passage")],
      "a new banner, then marked words, and later other passage too",
    );
    expect(fit.kept).toEqual(["a", "b"]);
    expect(captureIsSafe(fit)).toBe(true);
    expect(captureFitSummary(fit)).toBeNull();
  });

  it("says tomorrow's feed is not the page those marks are on", () => {
    /*
     * The case this exists for. Mark a tweet today; tomorrow the same URL holds
     * entirely different content, and replacing the capture would leave every
     * mark displaying an excerpt and pointing at nothing.
     */
    const fit = captureFit(
      [textMark("a", "a tweet from yesterday"), textMark("b", "another one")],
      "an entirely different set of posts",
    );
    expect(fit.stranded).toEqual(["a", "b"]);
    expect(captureIsSafe(fit)).toBe(false);
    expect(captureFitSummary(fit)).toBe("None of your 2 marks are on this version of the page.");
  });

  it("counts a partly changed page rather than rounding it", () => {
    const fit = captureFit(
      [textMark("a", "still here"), textMark("b", "gone now")],
      "still here, but not the other thing",
    );
    expect(fit.kept).toEqual(["a"]);
    expect(fit.stranded).toEqual(["b"]);
    expect(captureFitSummary(fit)).toBe("1 of 2 marks are not on this version of the page.");
  });

  it("will not judge a region mark", () => {
    // A rectangle has no words to look for; whether it still frames the right
    // thing is a layout question no search can answer.
    const fit = captureFit(
      [{ id: "r", anchor: { kind: "region", x: 0, y: 0, w: 10, h: 10 } }],
      "any text at all",
    );
    expect(fit.unknown).toEqual(["r"]);
    expect(captureIsSafe(fit)).toBe(true);
  });

  it("will not judge a mark with nothing to search for", () => {
    /*
     * Written before quotes were recorded, with no excerpt either. Its offsets
     * might still be right or might be pointing at whatever replaced them —
     * unknown is the honest answer, not a guess in either direction.
     */
    const fit = captureFit([{ id: "old", anchor: { kind: "text", start: 0, end: 4 } }], "text");
    expect(fit.unknown).toEqual(["old"]);
  });

  it("falls back to the excerpt when there is no recorded quote", () => {
    const fit = captureFit(
      [{ id: "old", anchor: { kind: "text", start: 0, end: 4 }, excerpt: "marked words" }],
      "still has marked words in it",
    );
    expect(fit.kept).toEqual(["old"]);
  });

  it("has nothing to say about a page with no marks", () => {
    const fit = captureFit([], "anything");
    expect(captureIsSafe(fit)).toBe(true);
    expect(captureFitSummary(fit)).toBeNull();
  });

  it("uses the singular for one lost mark", () => {
    const fit = captureFit([textMark("a", "gone")], "nothing like it");
    expect(captureFitSummary(fit)).toBe("The mark you made is not on this version of the page.");
  });
});
