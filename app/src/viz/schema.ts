/**
 * The viz program: the contract between the coach and the canvas.
 *
 * **The model never emits Excalidraw coordinates.** LLMs are unreliable at
 * coordinate geometry and reliable at structured semantic state, so the model
 * emits *what the structure contains at each step* and `render/<kind>.ts` lays
 * it out deterministically.
 *
 * Mirrors `src/llm/tools.rs` on the daemon side. Keep the two in step.
 */

export const VIZ_KINDS = [
  "array",
  "grid",
  "hashmap",
  "tree",
  "linkedlist",
  "heap",
  "stack",
  "queue",
  "graph",
  "trie",
  "unionfind",
  "dplist",
  "dptable",
  "segtree",
  "calltree",
  "composite",
  "bits",
] as const;

export type VizKind = (typeof VIZ_KINDS)[number];

/** Per-call cap on `animate_trace`. Extra frames are dropped, not rendered. */
export const MAX_TRACE_FRAMES = 40;

/**
 * One step. Frames carry the **full** state, not a diff, so the scrubber can
 * jump anywhere without replaying history.
 */
export interface VizFrame {
  label: string;
  /** Cell contents. For `grid`, an array of rows. */
  cells: unknown[];
  /** Named indices into `cells`, e.g. `{i: 0, j: 3}`. */
  pointers: Record<string, number>;
  /** Indices to emphasise this step. */
  highlight: number[];
  /** hashmap: `[key, value]` pairs. tree/graph/linkedlist: `[from, to]` edges. */
  entries: unknown[];
  note: string;
}

export interface VizProgram {
  viz: VizKind;
  /** Reusing an id replaces that diagram instead of adding another. */
  id: string;
  title: string;
  frames: VizFrame[];
}

export function isVizKind(value: unknown): value is VizKind {
  return typeof value === "string" && (VIZ_KINDS as readonly string[]).includes(value);
}

/**
 * Coerce a tool call's arguments into a program, or return null.
 *
 * Deliberately forgiving about *shape* — a local model will omit `title`, send
 * `pointers` as `null`, or hand back numbers as strings — and strict about the
 * two things that would break rendering: an unknown `viz` kind and an empty
 * `frames` array.
 */
export function parseVizProgram(raw: unknown): VizProgram | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (!isVizKind(record.viz)) return null;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  if (!id) return null;

  const rawFrames = Array.isArray(record.frames) ? record.frames : [];
  const frames = rawFrames.map(normalizeFrame).filter((frame): frame is VizFrame => frame !== null);
  if (frames.length === 0) return null;

  return {
    viz: record.viz,
    id,
    title: typeof record.title === "string" ? record.title : "",
    frames: frames.slice(0, MAX_TRACE_FRAMES),
  };
}

export function normalizeFrame(raw: unknown): VizFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const pointers: Record<string, number> = {};
  if (typeof record.pointers === "object" && record.pointers !== null) {
    for (const [name, value] of Object.entries(record.pointers as Record<string, unknown>)) {
      const index = Number(value);
      if (Number.isInteger(index)) pointers[name] = index;
    }
  }

  return {
    label: typeof record.label === "string" ? record.label : "",
    cells: Array.isArray(record.cells) ? record.cells : [],
    pointers,
    highlight: Array.isArray(record.highlight)
      ? record.highlight.map(Number).filter(Number.isInteger)
      : [],
    entries: Array.isArray(record.entries) ? record.entries : [],
    note: typeof record.note === "string" ? record.note : "",
  };
}

/** Keys a model reaches for when it wraps a scalar it was asked to give bare. */
const VALUE_KEYS = ["text", "value", "val", "label", "v", "key", "name"] as const;

/**
 * Render a cell value as board text.
 *
 * Cells are meant to be scalars, but models routinely wrap them — `[{"text":
 * "2"}, {"text": "7"}]` instead of `[2, 7]`. Stringifying that draws
 * `{"text":"2"}` inside the box, which is worse than useless on a student's
 * board, so a single-valued wrapper is unwrapped rather than printed.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "·";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    // One key, or one of the names above: that is the value, not a structure.
    const named = VALUE_KEYS.find((key) => record[key] !== undefined);
    const only = keys.length === 1 ? keys[0] : undefined;
    const inner = named ?? only;
    if (inner !== undefined && typeof record[inner] !== "object") {
      return cellText(record[inner]);
    }
  }
  return JSON.stringify(value);
}

/** An `[a, b]` pair out of an `entries` item, tolerating objects and strings. */
export function entryPair(entry: unknown): [string, string] | null {
  if (Array.isArray(entry) && entry.length >= 2) {
    return [cellText(entry[0]), cellText(entry[1])];
  }
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    const from = record.from ?? record.key ?? record.k;
    const to = record.to ?? record.value ?? record.v;
    if (from !== undefined && to !== undefined) return [cellText(from), cellText(to)];
    // A wrapped pair — `{"text": "1 -> 0"}` — is the same wrapper habit that
    // hits `cells`, and dropping it empties the whole map: every row of a
    // nine-frame trace disappeared behind an "(empty map)" placeholder.
    const unwrapped = cellText(entry);
    if (unwrapped !== JSON.stringify(entry)) return entryPair(unwrapped);
  }
  if (typeof entry === "string") {
    for (const arrow of ["->", "→", "=>", ":"]) {
      if (entry.includes(arrow)) {
        const [from, to] = entry.split(arrow, 2);
        return [from.trim(), to.trim()];
      }
    }
  }
  return null;
}

/** Trie node: `{ch, end}` or a character string (`"a*"` marks a word end). */
export function trieNode(value: unknown): { ch: string; end: boolean } {
  if (value === null || value === undefined) return { ch: "", end: false };
  if (typeof value === "string") {
    const end = value.endsWith("*") || value.endsWith("$");
    return { ch: end ? value.slice(0, -1) : value, end };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const raw = record.ch ?? record.char ?? record.c;
    const ch = raw === undefined ? "" : cellText(raw);
    const end = Boolean(record.end ?? record.isEnd ?? record.terminal ?? record.word);
    return { ch, end };
  }
  return { ch: cellText(value), end: false };
}

/** Segment-tree node: `{lo, hi, val}` or `[lo, hi, val]`. */
export function intervalNode(
  value: unknown,
): { lo: string; hi: string; val: string } | null {
  if (Array.isArray(value) && value.length >= 3) {
    return { lo: cellText(value[0]), hi: cellText(value[1]), val: cellText(value[2]) };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const lo = record.lo ?? record.l ?? record.left ?? record.start;
    const hi = record.hi ?? record.r ?? record.right ?? record.end;
    const val = record.val ?? record.value ?? record.v ?? record.sum;
    if (lo === undefined && hi === undefined && val === undefined) return null;
    return {
      lo: cellText(lo ?? ""),
      hi: cellText(hi ?? ""),
      val: cellText(val ?? ""),
    };
  }
  return null;
}

/** Recursion frame label: `{fn, args}` or a preformatted string. */
export function callLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const fn = record.fn ?? record.name ?? record.func ?? record.call;
    if (fn !== undefined) {
      const name = cellText(fn);
      const args = record.args ?? record.arg ?? record.arguments;
      if (args === undefined) return name;
      const argText = Array.isArray(args) ? args.map(cellText).join(", ") : cellText(args);
      return `${name}(${argText})`;
    }
  }
  return cellText(value);
}

/** Integer parent→child edges from `entries`, ignoring anything unreadable. */
export function parentChildEdges(entries: unknown[], count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const entry of entries) {
    const pair = entryPair(entry);
    if (!pair) continue;
    const from = Number(pair[0]);
    const to = Number(pair[1]);
    if (
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 0 &&
      to >= 0 &&
      from < count &&
      to < count &&
      from !== to
    ) {
      out.push([from, to]);
    }
  }
  return out;
}

/** A nested panel inside `composite`. Depth-1 only — nested composites are skipped. */
export function compositePanel(
  value: unknown,
): { viz: VizKind; title: string; frame: VizFrame } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const viz = record.viz ?? record.kind;
  if (!isVizKind(viz) || viz === "composite") return null;
  const frame = normalizeFrame(record);
  if (!frame) return null;
  return {
    viz,
    title: typeof record.title === "string" ? record.title : "",
    frame,
  };
}
