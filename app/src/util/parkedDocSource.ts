/**
 * Markdown (and other text) that was opened but never Saved.
 *
 * The tab chip cannot keep a huge study guide — localStorage caps the field
 * at 80k characters. IndexedDB can. Park the text under the content hash so
 * relaunch can open the same file without a library row and without a
 * missing-file dialog.
 */

import { getContent, putContent } from "./contentStore";

function parkId(hash: string): string {
  return `park-src:${hash}`;
}

export async function parkDocSource(hash: string, source: string): Promise<void> {
  if (!hash || !source) return;
  await putContent(parkId(hash), { source });
}

export async function getParkedDocSource(hash: string): Promise<string | null> {
  if (!hash) return null;
  const row = await getContent<{ source?: unknown }>(parkId(hash));
  return typeof row?.source === "string" && row.source.length > 0 ? row.source : null;
}
