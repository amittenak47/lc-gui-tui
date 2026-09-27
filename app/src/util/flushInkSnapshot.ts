import type { EncodedInk } from "../canvas/inkCodec";

interface InkSnapshotSource {
  getInkRevision(): number;
  takeDirtyInkPages(): Map<number, EncodedInk>;
  markInkPagesFlushed(ids: Iterable<number>): void;
}

/** A completed write must not clear strokes added while IndexedDB was busy. */
export async function flushInkSnapshot(
  board: InkSnapshotSource,
  write: (pages: Map<number, EncodedInk>) => Promise<void>,
): Promise<boolean> {
  const revision = board.getInkRevision();
  const pages = board.takeDirtyInkPages();
  if (!pages.size) return true;
  await write(pages);
  if (board.getInkRevision() !== revision) return false;
  board.markInkPagesFlushed(pages.keys());
  return true;
}
