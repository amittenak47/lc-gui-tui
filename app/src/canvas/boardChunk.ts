/**
 * The board, fetched on demand.
 *
 * `Board` is the only door to Excalidraw — about 1.1 MB raw, 363 KB gzipped —
 * and importing it from `Workspace` put all of it on the App graph, which
 * `index.html` then module-preloaded. Home renders no board at all, so first
 * paint was waiting on a megabyte it had no use for.
 *
 * One promise, kept: a second workspace opening a second document must not
 * fetch or evaluate the chunk again, and a workspace remounting must find it
 * already there. The failed case is *not* cached — a chunk that failed to load
 * because the device was offline for a moment should be retried on the next
 * open, not remembered as broken for the session.
 */
import type { Board } from "./Board";

export type BoardComponent = typeof Board;

let pending: Promise<BoardComponent> | null = null;
let loaded: BoardComponent | null = null;

/** The board component if the chunk is already here, otherwise null. */
export function peekBoardComponent(): BoardComponent | null {
  return loaded;
}

/** Fetch the board chunk, or hand back the one already fetched. */
export function loadBoardComponent(): Promise<BoardComponent> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = import("./Board").then(
    (module) => {
      loaded = module.Board;
      pending = null;
      return module.Board;
    },
    (cause: unknown) => {
      pending = null;
      throw cause instanceof Error
        ? cause
        : new Error("the drawing canvas could not be loaded");
    },
  );
  return pending;
}
