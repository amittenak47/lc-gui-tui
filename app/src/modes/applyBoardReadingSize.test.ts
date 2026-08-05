import { describe, expect, it } from "vitest";

import { STATEMENT_PROSE_BASE } from "../templates/readingColumn";
import { FONT_UI } from "../templates/skeleton";
import { applyBoardReadingSize, type ReadingElement } from "./applyBoardReadingSize";
import {
  statementSceneFont,
  STATEMENT_CSS_PX,
  STATEMENT_LINE_HEIGHT_RATIO,
} from "./codeFontSize";
import { linedRuleClearance, textBaselineOffset } from "./textBaseline";

/**
 * A reading column and the screen it was measured for.
 *
 * The statement's scene font is derived from both, so a test that pins a font
 * size has to name a page as well as a size — 44 scene units means one thing on
 * a phone-width column and something unreadable on a four-screen one.
 */
const COLUMN = 400;
const VIEWPORT = 400;

function text(
  id: string,
  opts: {
    fontSize: number;
    y: number;
    oy: number;
    height?: number;
    fixed?: boolean;
    text?: string;
  },
): ReadingElement {
  return {
    id,
    type: "text",
    x: 36,
    y: opts.y,
    width: 400,
    height: opts.height ?? opts.fontSize * 1.4,
    fontSize: opts.fontSize,
    text: opts.text ?? "hello",
    customData: {
      lcRegion: "constraints",
      lcRegionOx: 36,
      lcRegionOy: opts.oy,
      ...(opts.fixed ? { lcFixedSize: true } : {}),
    },
  };
}

function withBodyBase(el: ReadingElement, base = STATEMENT_PROSE_BASE): ReadingElement {
  return {
    ...el,
    customData: {
      ...el.customData,
      lcFontBase: base,
      lcLineHeightBase: STATEMENT_LINE_HEIGHT_RATIO,
      lcRegionOyBase: el.customData?.lcRegionOy,
    },
  };
}

describe("applyBoardReadingSize", () => {
  it("scales body only — title and tags stay put", () => {
    const elements: ReadingElement[] = [
      {
        id: "lcregion-constraints-frame",
        type: "rectangle",
        x: 0,
        y: 0,
        width: COLUMN,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      text("lcregion-constraints-title", { fontSize: 32, y: 64, oy: 64, height: 70 }),
      text("lcregion-constraints-meta-0", {
        fontSize: 14,
        y: 150,
        oy: 150,
        fixed: true,
      }),
      withBodyBase(
        text("lcregion-constraints-body-0", {
          fontSize: STATEMENT_PROSE_BASE,
          y: 200,
          oy: 200,
          height: 40,
          text: "line one",
        }),
      ),
      withBodyBase(
        text("lcregion-constraints-body-1", {
          fontSize: STATEMENT_PROSE_BASE,
          y: 280,
          oy: 280,
          height: 40,
          text: "line two",
        }),
      ),
    ];

    const large = applyBoardReadingSize(elements, "L", { viewportWidth: VIEWPORT });
    const title = large.find((el) => el.id.endsWith("-title"))!;
    const meta = large.find((el) => el.id.includes("-meta-"))!;
    const body0 = large.find((el) => el.id.endsWith("-body-0"))!;
    const body1 = large.find((el) => el.id.endsWith("-body-1"))!;

    expect(title.fontSize).toBe(32);
    expect(title.y).toBe(64);
    expect(meta.fontSize).toBe(14);
    expect(meta.y).toBe(150);

    expect(body0.fontSize).toBe(statementSceneFont("L", COLUMN, VIEWPORT));
    expect(body0.y).toBe(200);
    expect(body1.y).toBeGreaterThan(body0.y!);
  });

  it("keeps the reader's type size the same on a wider screen", () => {
    /*
     * The column is capped, so a bigger screen fits it at a bigger zoom. The
     * scene font has to come down by exactly that much or the same statement
     * reads as billboard type on a tablet.
     */
    const phone = statementSceneFont("M", 360, 400);
    const tablet = statementSceneFont("M", 760, 1024);
    expect(phone * (400 / 360)).toBeCloseTo(STATEMENT_CSS_PX.M, 1);
    expect(tablet * (1024 / 760)).toBeCloseTo(STATEMENT_CSS_PX.M, 1);
    expect(tablet).toBeLessThan(phone);
  });

  it("does not change body font when zoom changes", () => {
    const elements: ReadingElement[] = [
      {
        id: "lcregion-constraints-frame",
        type: "rectangle",
        x: 0,
        y: 0,
        width: COLUMN,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      withBodyBase(
        text("lcregion-constraints-body-0", {
          fontSize: STATEMENT_PROSE_BASE,
          y: 200,
          oy: 200,
          text: "hello",
        }),
      ),
    ];
    const expected = statementSceneFont("M", COLUMN, VIEWPORT);
    const a = applyBoardReadingSize(elements, "M", { zoom: 0.5, viewportWidth: VIEWPORT });
    const b = applyBoardReadingSize(elements, "M", { zoom: 1.5, viewportWidth: VIEWPORT });
    expect(a[1].fontSize).toBe(expected);
    expect(b[1].fontSize).toBe(expected);
  });

  it("snaps body baselines onto the lined grid", () => {
    const fontSize = statementSceneFont("M", COLUMN, VIEWPORT);
    const pitch = fontSize * STATEMENT_LINE_HEIGHT_RATIO;
    const frameY = 0;
    const offset = textBaselineOffset(fontSize, STATEMENT_LINE_HEIGHT_RATIO, FONT_UI);
    const elements: ReadingElement[] = [
      {
        id: "lcregion-constraints-frame",
        type: "rectangle",
        x: 0,
        y: frameY,
        width: COLUMN,
        height: 800,
        customData: { lcRegion: "constraints", lcRegionFrame: true },
      },
      withBodyBase(
        text("lcregion-constraints-body-0", {
          fontSize: STATEMENT_PROSE_BASE,
          y: frameY + 200,
          oy: 200,
          height: 40,
          text: "line one",
        }),
      ),
    ];

    const lined = applyBoardReadingSize(elements, "M", {
      lined: true,
      viewportWidth: VIEWPORT,
    });
    const body = lined.find((el) => el.id.endsWith("-body-0"))!;
    const baseline = body.y! + textBaselineOffset(body.fontSize!, body.lineHeight!, FONT_UI);
    const clearance = linedRuleClearance(body.fontSize!);
    // The grid is snapped from where the first line's *baseline* falls, not
    // from its top edge — so the expected rule is derived the same way.
    const anchorBaseline =
      200 + textBaselineOffset(STATEMENT_PROSE_BASE, STATEMENT_LINE_HEIGHT_RATIO, FONT_UI);
    const ruleY = Math.round(anchorBaseline / pitch) * pitch;
    // The claim is "the baseline sits on a rule", not "the remainder is zero" —
    // a fractional pitch makes the modulo land just under the pitch instead.
    expect(baseline + clearance).toBeCloseTo(ruleY, 4);
    expect(body.lineHeight).toBe(STATEMENT_LINE_HEIGHT_RATIO);
    expect(body.y).toBeCloseTo(frameY + ruleY - clearance - offset, 1);
  });
});
