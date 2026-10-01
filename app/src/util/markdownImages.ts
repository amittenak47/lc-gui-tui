/**
 * Images a markdown note points at beside it on disk.
 *
 * A note written elsewhere keeps its figures in a folder next to it —
 * `![plot](figures/plot.png)`. This app opens files through a picker that
 * hands over the file and nothing around it, so those references pointed at
 * nothing: a broken image on the desktop, and nothing at all to send to the
 * tablet. Given the note's folder, each picture is written into the note
 * itself as a `data:` URI, so it renders anywhere and travels with the text
 * through the same sync the text already has.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** `![alt](target "title")`, the target optionally in angle brackets. */
const MD_IMAGE = /(!\[[^\]]*\]\(\s*)(<[^>\n]+>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*\))/g;
/** `<img src="target">`. */
const HTML_IMAGE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
/** `[id]: target` — a reference definition an image may use. */
const DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|\S+)/gm;

function bare(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

/** A path beside the note: no scheme, not rooted, not a fragment, and a picture. */
export function isLocalImageTarget(target: string): boolean {
  const t = bare(target).trim();
  if (!t || t.startsWith("/") || t.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  return IMAGE_EXT.test(t.split(/[?#]/)[0]!);
}

function each(source: string, visit: (target: string) => void): void {
  for (const m of source.matchAll(MD_IMAGE)) visit(m[2]!);
  for (const m of source.matchAll(HTML_IMAGE)) visit(m[3]!);
  for (const m of source.matchAll(DEFINITION)) visit(m[2]!);
}

/** The local pictures a note refers to, each once, as written. */
export function localImageRefs(source: string): string[] {
  const out = new Set<string>();
  each(source, (target) => {
    if (isLocalImageTarget(target)) out.add(bare(target).trim());
  });
  return [...out];
}

/** `a/./b/../c.png` → `a/c.png`, decoded, forward slashes. */
export function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    /* keep it as written */
  }
  const parts: string[] = [];
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export interface FolderFile {
  /** Path inside the picked folder, e.g. `notes/figures/plot.png`. */
  path: string;
  file: Blob;
}

/**
 * Find the file a reference means. Resolved against the note's own folder
 * first; failing that, a file of the same name, if exactly one has it.
 */
function resolve(target: string, noteDir: string, files: readonly FolderFile[]): FolderFile | null {
  const clean = bare(target).trim().split(/[?#]/)[0]!;
  const wanted = normalizePath(noteDir ? `${noteDir}/${clean}` : clean);
  const exact = files.find((f) => normalizePath(f.path) === wanted);
  if (exact) return exact;
  const name = wanted.split("/").pop()!.toLowerCase();
  const named = files.filter((f) => normalizePath(f.path).split("/").pop()!.toLowerCase() === name);
  return named.length === 1 ? named[0]! : null;
}

async function dataUri(file: Blob, path: string): Promise<string> {
  const ext = path.split(".").pop()!.toLowerCase();
  const type = file.type || MIME[ext] || "application/octet-stream";
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

export interface InlinedImages {
  text: string;
  inlined: string[];
  missing: string[];
}

/**
 * Write each local picture the note refers to into it.
 *
 * `noteName` is the note's file name, used to find where it sits inside the
 * picked folder: references are relative to the note, not to the folder.
 */
export async function inlineMarkdownImages(
  source: string,
  noteName: string,
  files: readonly FolderFile[],
): Promise<InlinedImages> {
  const note = files.find((f) => normalizePath(f.path).split("/").pop() === noteName);
  const noteDir = note ? normalizePath(note.path).split("/").slice(0, -1).join("/") : "";
  const uris = new Map<string, string>();
  const missing: string[] = [];
  for (const ref of localImageRefs(source)) {
    const found = resolve(ref, noteDir, files);
    if (found) uris.set(ref, await dataUri(found.file, found.path));
    else missing.push(ref);
  }
  const swap = (target: string) => {
    const uri = uris.get(bare(target).trim());
    return uri ?? target;
  };
  const text = source
    .replace(MD_IMAGE, (_all, open: string, target: string, close: string) => `${open}${swap(target)}${close}`)
    .replace(HTML_IMAGE, (_all, open: string, quote: string, target: string) => `${open}${quote}${swap(target)}${quote}`)
    .replace(DEFINITION, (_all, open: string, target: string) => `${open}${swap(target)}`);
  return { text, inlined: [...uris.keys()], missing };
}
