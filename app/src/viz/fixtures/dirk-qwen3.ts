/**
 * Hand-shaped programs for Dirk-Qwen3.8-27B — the model golden tests target.
 *
 * Not live LLM output (CI has no local GGUF). Structured the way that model
 * emits viz tools: objects for nodes, parent→child edges, full state per frame.
 * The granite hashmap fixture stays as the empty-map regression.
 */

/** "Build a trie for app / apple." */
export const DIRK_TRIE_APP_APPLE = {
  viz: "trie",
  id: "trie_app_apple",
  title: "Trie for app / apple",
  frames: [
    {
      label: "inserted app and apple",
      cells: [
        { ch: "", end: false },
        { ch: "a", end: false },
        { ch: "p", end: false },
        { ch: "p", end: true },
        { ch: "l", end: false },
        { ch: "e", end: true },
      ],
      entries: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ],
      pointers: {},
      highlight: [3, 5],
      note: "app ends at the second p; apple continues l-e",
    },
  ],
};

/** "Union (1,2) then find(2)." */
export const DIRK_UNION_1_2_FIND_2 = {
  viz: "unionfind",
  id: "uf_12",
  title: "union(1,2) then find(2)",
  frames: [
    {
      label: "start",
      cells: [0, 1, 2],
      entries: [0, 0, 0],
      pointers: {},
      highlight: [],
      note: "each element is its own parent",
    },
    {
      label: "union(1,2)",
      cells: [0, 1, 1],
      entries: [0, 1, 0],
      pointers: {},
      highlight: [1, 2],
      note: "2 now points at 1",
    },
    {
      label: "find(2)",
      cells: [0, 1, 1],
      entries: [0, 1, 0],
      pointers: {},
      highlight: [2],
      note: "find(2) walks to parent 1",
    },
  ],
};

/** "Edit-distance table, one step." cat → cut after filling dp[2][2]. */
export const DIRK_EDIT_DISTANCE_ONE_STEP = {
  viz: "dptable",
  id: "edit_cat_cut",
  title: "edit distance cat → cut",
  frames: [
    {
      label: "dp[2][2] replace a→u",
      cells: [
        [0, 1, 2, 3],
        [1, 0, 1, 2],
        [2, 1, 1, 2],
        [3, 2, 2, 1],
      ],
      entries: [
        ["", "c", "u", "t"],
        ["", "c", "a", "t"],
      ],
      pointers: {},
      highlight: [10],
      note: "replace a with u, cost 1",
    },
  ],
};
