/**
 * The renderer against real local-model output.
 *
 * The hand-written fixtures in `render/render.test.ts` are well-formed by
 * construction. These are not — they are verbatim from granite-4.1-8b, and they
 * are what the pipeline actually has to cope with.
 */

import { describe, expect, it } from "vitest";

import { agentSlotOrigin } from "../templates/regions";
import { GRANITE_CONTENTLESS, GRANITE_HASHMAP } from "./fixtures/granite-4.1-8b";
import { mergeVizElements } from "./apply";
import { renderViz } from "./render";
import { entryPair, parseVizProgram } from "./schema";

const ORIGIN = agentSlotOrigin(0);

describe("granite-4.1-8b hashmap output", () => {
  const program = parseVizProgram(GRANITE_HASHMAP);

  it("parses", () => {
    expect(program).not.toBeNull();
    expect(program!.viz).toBe("hashmap");
    expect(program!.frames).toHaveLength(2);
  });

  it("reads {key, value} objects, not just [key, value] pairs", () => {
    // The tool schema asks for pairs; granite sends objects. Both must work.
    expect(entryPair({ key: 2, value: 0 })).toEqual(["2", "0"]);
    expect(entryPair([2, 0])).toEqual(["2", "0"]);
  });

  it("renders the map's real contents, not an empty box", () => {
    const elements = renderViz(program!, 1, ORIGIN);
    const labels = elements
      .map((element) => element.label?.text)
      .filter((text): text is string => typeof text === "string");

    // Frame 1 holds {2: 0, 7: 1}, so both keys and both values must appear.
    expect(labels).toContain("2");
    expect(labels).toContain("7");
    expect(labels).toContain("0");
    expect(labels).toContain("1");
    expect(elements.some((element) => element.text === "(empty map)")).toBe(false);
  });

  it("grows from one row to two across the frames, reusing element ids", () => {
    const first = renderViz(program!, 0, ORIGIN);
    const second = renderViz(program!, 1, ORIGIN);

    const rowsIn = (elements: typeof first) =>
      elements.filter((element) => element.id?.includes("-key-")).length;
    expect(rowsIn(first)).toBe(1);
    expect(rowsIn(second)).toBe(2);

    // Row 0 keeps its id, so stepping updates it rather than stacking a copy.
    expect(second.some((element) => element.id === first.find((e) => e.id?.endsWith("-key-0"))?.id)).toBe(true);

    // And merging leaves one generation on the board.
    const scene = mergeVizElements([], first, program!.id) as Array<{ id: string }>;
    const stepped = mergeVizElements(
      scene.map((element) => ({ ...element, customData: { lcVizId: program!.id } })),
      second,
      program!.id,
    );
    expect(stepped).toHaveLength(second.length);
  });

  it("tolerates the vestigial cells: [{}] granite emits alongside entries", () => {
    // `cells` is ignored for hashmap, so the junk must not break layout.
    expect(program!.frames[0].cells).toEqual([{}]);
    expect(() => renderViz(program!, 0, ORIGIN)).not.toThrow();
  });
});

describe("granite's contentless output", () => {
  it("still parses — which is why the daemon, not the schema, has to reject it", () => {
    // Structurally valid: right kind, three frames, plausible labels. The
    // emptiness is semantic, and `VizProgram::rejection` on the daemon catches
    // it before it ever reaches this renderer.
    const program = parseVizProgram(GRANITE_CONTENTLESS);
    expect(program).not.toBeNull();
    expect(program!.frames).toHaveLength(3);
    expect(program!.frames.every((frame) => frame.entries.length === 0)).toBe(true);
  });

  it("would have drawn an empty map, confirming the rejection is worth having", () => {
    const program = parseVizProgram(GRANITE_CONTENTLESS)!;
    const elements = renderViz(program, 0, ORIGIN);
    expect(elements.some((element) => element.text === "(empty map)")).toBe(true);
  });
});
