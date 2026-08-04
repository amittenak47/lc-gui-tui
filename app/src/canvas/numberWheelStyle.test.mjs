/**
 * The number wheel centres the selected value by padding the slot list with
 * empty divs at both ends, so min and max can sit in the middle band like any
 * other value. That only holds if a pad slot keeps its height.
 *
 * The window is a flex column of five 22px slots inside a 44px box, so every
 * slot is asked to shrink. A slot with a number in it refuses — its line box is
 * its min-content height — but an empty pad has nothing to stop it and
 * collapses to zero. The stack then sat one slot too high at whichever end the
 * pads were on: at min the band highlighted min+1 with min hanging below it,
 * and at max it highlighted max-1 with max half cut off above.
 *
 * Layout can't be measured here — jsdom does none — so these read the
 * stylesheet. Kept as .mjs because importing `node:fs` from a typechecked file
 * pulls @types/node's globals in behind it, which changes what `setTimeout`
 * returns across the app.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Body of the first `selector { … }` rule, comments stripped. */
function ruleBody(selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule is missing from styles.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe(".lc-number-wheel-item", () => {
  const body = ruleBody(".lc-number-wheel-item");

  it("does not let a slot shrink, so empty pad slots keep their height", () => {
    const flex = body.match(/(?:^|;)\s*flex\s*:\s*([^;]+)/)?.[1].trim();
    const flexShrink = body.match(/(?:^|;)\s*flex-shrink\s*:\s*([^;]+)/)?.[1].trim();

    // Either the shorthand's shrink factor, or the longhand.
    const shrinkFactor = flex?.split(/\s+/)[1] ?? flexShrink;
    expect(
      shrinkFactor,
      "pad slots collapse to 0 height without a 0 shrink factor, pushing min/max off the selection band",
    ).toBe("0");
  });

  it("still pins the slot to the 22px the band and momentum maths assume", () => {
    expect(body).toMatch(/(?:^|;)\s*height\s*:\s*22px/);
  });
});
