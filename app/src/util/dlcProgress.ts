import type { DlcStatus } from "../api/client";

/** Events may overtake an invoke/poll response. Never roll progress backward. */
export function mergeDlcStatus(current: DlcStatus[], incoming: DlcStatus[]): DlcStatus[] {
  const rows = new Map(current.map(row => [row.slug, row]));
  for (const row of incoming) {
    const previous = rows.get(row.slug);
    if (!previous || row.revision == null || previous.revision == null || row.revision > previous.revision) rows.set(row.slug, row);
  }
  return [...rows.values()];
}

export function dlcProgressLabel(row: DlcStatus, bytes: (n: number) => string): string {
  if (row.phase === "starting") return "Starting download…";
  if (row.phase === "downloading") return row.total
    ? `Downloading ${bytes(row.downloaded ?? 0)} / ${bytes(row.total)}`
    : row.downloaded ? `Downloading ${bytes(row.downloaded)}` : "Connecting…";
  if (row.phase === "unpacking") return "Unpacking downloaded files…";
  if (row.phase === "indexing") return `Preparing problems · ${row.count.toLocaleString()} indexed`;
  if (row.phase === "error") return "Installation failed · retry available";
  return row.installed ? `${row.count.toLocaleString()} problems ready` : "Not installed";
}
