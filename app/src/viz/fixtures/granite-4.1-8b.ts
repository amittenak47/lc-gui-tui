/**
 * Real tool-call output from granite-4.1-8b-Q4_K_M via llama.cpp.
 *
 * Captured while validating the coach against a local model. Kept as a fixture
 * because a small local model's output is the actual input this renderer has to
 * survive, and it differs from a hand-written example in specific ways:
 *
 * - `cells` carries a vestigial `[{}]` even when the real contents are in
 *   `entries`;
 * - `entries` arrive as `{key, value}` objects, not `[key, value]` pairs;
 * - `pointers` is sometimes empty, sometimes misused to hold values;
 * - `note` is usually missing entirely.
 */

/** What `POST /coach/viz` returned for "animate the one-pass hash map". */
export const GRANITE_HASHMAP = {
  viz: "hashmap",
  id: "two_sum_hashmap",
  title: "Two‑Sum one‑pass hash map",
  frames: [
    {
      label: "i=0, num=2",
      cells: [{}],
      entries: [{ key: 2, value: 0 }],
      pointers: {},
      highlight: [0],
      note: "",
    },
    {
      label: "i=1, num=7",
      cells: [{}],
      entries: [
        { key: 2, value: 0 },
        { key: 7, value: 1 },
      ],
      pointers: {},
      highlight: [1],
      note: "",
    },
  ],
};

/**
 * An earlier granite reply, before the tool schema spelled out where contents
 * go: three frames with the map's contents misfiled into `pointers`. The daemon
 * rejects this shape now (`VizProgram::rejection`), so it should never reach the
 * renderer — this fixture documents what "nothing to draw" looks like.
 */
export const GRANITE_CONTENTLESS = {
  viz: "hashmap",
  id: "two_sum_hashmap",
  title: "Two-Sum one-pass hash map",
  frames: [
    { label: "i=0, num=2", cells: [], entries: [], pointers: { map: 2, need: 7, num: 0 }, highlight: [0] },
    { label: "i=1, num=7", cells: [], entries: [], pointers: { map: 7, need: 2, num: 1 }, highlight: [1] },
    { label: "found pair", cells: [], entries: [], pointers: {}, highlight: [0, 1] },
  ],
};
