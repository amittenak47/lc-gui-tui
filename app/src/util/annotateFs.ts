/**
 * Getting a document file into the app, and an annotation set back out.
 *
 * Deliberately not a Tauri filesystem plugin in v1. The app runs in a WebView on
 * the tablet as well as on the desktop, and a hidden `<input type="file">` is
 * the one path that works in both without a Rust dependency, a capability
 * grant, or a permission prompt. Annotations live in `annotateStore` keyed by the
 * document's content hash, so reopening the same file finds its ink again
 * without ever knowing where on disk the file came from.
 *
 * {@link exportAnnotateSidecar} is the escape hatch: it hands back a
 * `.lc-ink.json.gz` the writer can keep beside the source, so an annotation set
 * is not trapped in one browser's storage. Reading one back is
 * {@link readAnnotateSidecar}, and the import path sniffs gzip rather than
 * trusting the extension, so an uncompressed sidecar still opens.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { codeAcceptExtensions, isCodeName } from "./codeLanguages";
import { readBlobBytes } from "./docBytes";
import { traceOpen } from "./messageOf";
import { sanitizeFootnotes, type DocFootnote } from "./docFootnotes";
import { canGzip, gzipText, textFromMaybeGzip } from "./gzip";
import type { DocType } from "./annotateStore";

export { CODE_SOURCE_MAX_CHARS, languageForName } from "./codeLanguages";

/** Extensions the picker offers, and what we accept when one is dropped in. */
export const MARKDOWN_ACCEPT = ".md,.markdown,.mdown,.mkd,text/markdown";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

const CODE_ACCEPT = codeAcceptExtensions().join(",");

/**
 * Desktop picker filter. PDF/EPUB MIME types come first on purpose: some
 * WebViews only honour the first `accept` token, and this list used to start
 * with `.md` / `text/markdown`, which hid every textbook.
 *
 * Android ignores this — see {@link documentPickerAccept}.
 */
export const DOCUMENT_ACCEPT = [
  "application/pdf,.pdf",
  "application/epub+zip,.epub",
  MARKDOWN_ACCEPT,
  CODE_ACCEPT,
  "text/plain",
].join(",");

/** `accept` actually handed to the file input. */
export function documentPickerAccept(userAgent?: string): string {
  const ua =
    userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  // Android DocumentsUI / WebView file chooser treats `accept` as MIME types
  // and often keeps only the first one. A long mix of `.md`, `.py`, `.pdf`
  // then greys out PDFs and EPUBs. `*/*` still lets the pad refuse inside
  // {@link docTypeForPicked}; the filter is what was wrong, not the open path.
  if (/\bandroid\b/i.test(ua)) return "*/*";
  return DOCUMENT_ACCEPT;
}

export interface OpenedMarkdown {
  name: string;
  source: string;
}

/**
 * A file the pad has read, in whichever form its type needs.
 *
 * Markdown and code arrive as text because that is what gets rendered and
 * stored; PDF and EPUB arrive as bytes because that is what their renderers
 * parse and what goes into IndexedDB. One shape rather than two so the open
 * path does not fork before it has to.
 */
export interface OpenedDocument {
  name: string;
  docType: DocType;
  /** Markdown and code. */
  text?: string;
  /** PDF and EPUB only. */
  bytes?: ArrayBuffer;
}

export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * What kind of document a file is, by name.
 *
 * Extension rather than MIME type: a WebView file picker on Android hands back
 * an empty or wrong `type` often enough that trusting it means refusing files
 * the user can plainly see are PDFs. Anything unrecognised opens as code
 * (escaped plaintext) — safer than feeding unknown bytes through a markdown
 * parser, and refusing to open is a dead end.
 */
export function docTypeForName(name: string): DocType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".epub")) return "epub";
  if (isMarkdownName(name)) return "markdown";
  if (isCodeName(name)) return "code";
  return "code";
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

function looksLikeEpub(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 256)));
  return head.includes("application/epub+zip");
}

/**
 * Kind of a picked file, using bytes and MIME when the name is empty or wrong.
 *
 * Android's picker often hands back `document`, a content-URI basename, or no
 * name at all. Trusting {@link docTypeForName} alone then opens a PDF as code
 * (garbled text) and a real markdown file is the only thing that still looks
 * right.
 */
export function docTypeForPicked(
  file: { name: string; type?: string },
  bytes?: ArrayBuffer | null,
): DocType {
  if (bytes && bytes.byteLength > 0) {
    const raw = new Uint8Array(bytes);
    if (looksLikePdf(raw)) return "pdf";
    if (looksLikeEpub(raw)) return "epub";
  }
  const named = docTypeForName(file.name);
  if (named === "pdf" || named === "epub" || named === "markdown") return named;
  const mime = (file.type ?? "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/epub+zip" || mime === "application/epub") return "epub";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  return named;
}

function fallbackPickedName(docType: DocType): string {
  if (docType === "pdf") return "document.pdf";
  if (docType === "epub") return "document.epub";
  if (docType === "markdown") return "document.md";
  return "document";
}

/** True when the pad stores this type as a string in the library entry. */
export function isTextDocType(docType: DocType): boolean {
  return docType === "markdown" || docType === "code" || docType === "web";
}

/**
 * Copy when the library still has the annotation set but IndexedDB no longer
 * has the PDF/EPUB bytes.
 *
 * This is not "the file is gone from the tablet". The original in Files is
 * untouched; the app never stored a URI, so it cannot reopen that copy itself.
 */
export function missingAppFileCopy(name: string): string {
  return (
    `“${name}” is still in the library, but this app no longer has its copy of the file. ` +
    `Pick the same file again — the one in Files is untouched — and the annotations will come back.`
  );
}

/**
 * After the WebView is back in front, wait this long for `change` before
 * treating the picker as dismissed.
 *
 * Android's DocumentsUI fires neither `cancel` nor `change` on back-swipe, or
 * when the user leaves the picker by switching apps. The WebView becomes
 * visible again with an empty input. Desktop Chrome usually fires `cancel`;
 * this is the fallback that unsticks that path too.
 *
 * Long enough that a real pick's `change` (which often arrives a beat after
 * `focus` / `visibilitychange`) still wins; short enough that a dismiss does
 * not look like a hang.
 */
export const FILE_PICKER_RESUME_MS = 2500;
/** Pointer in the WebView: the picker activity is gone; don't wait a full resume. */
export const FILE_PICKER_POINTER_MS = 400;
/** How often the poll re-reads `input.files` once the deadline has passed. */
export const FILE_PICKER_POLL_MS = 500;
/**
 * Total silence before a pick is treated as dismissed.
 *
 * Generous on purpose: the cost of waiting too long is a sheet that stays busy
 * a few seconds after someone backed out, and the cost of not waiting long
 * enough is losing the file they chose without saying so.
 */
export const FILE_PICKER_GIVE_UP_MS = 20_000;

function pickFromHiddenInput<T>(
  accept: string,
  read: (file: File) => Promise<T>,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    // Off-screen rather than `display: none`: a hidden input is ignored by
    // some WebViews when `click()` is called programmatically.
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    let chosen = false;
    let leftForeground = false;
    let resumeTimer = 0;

    const cleanup = () => {
      window.clearTimeout(resumeTimer);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("visibilitychange", onVisibility);
      input.remove();
    };

    const settle = (value: T | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };

    /*
     * Give up on a pick only after watching for a while, not on one look.
     *
     * Android hands the file over through `change` whenever its content
     * resolver gets round to it. For a textbook that is routinely slower than
     * any single timeout worth waiting through, and the old single-shot check
     * turned that into a silent loss: the timer fired, `input.files` was still
     * empty, the promise resolved `null`, and the caller's `if (!picked)
     * return` swallowed the whole open. The reader picked a file and nothing
     * happened — no document, no error, nothing in the log.
     *
     * So the deadline only starts a poll. Each tick re-reads `input.files`,
     * because the one thing we can be sure of is that a file arriving late is
     * still a file the reader chose.
     */
    const armResume = (delayMs: number) => {
      if (settled || chosen) return;
      window.clearTimeout(resumeTimer);
      let waited = 0;
      const check = () => {
        if (settled || chosen) return;
        if (input.files && input.files.length > 0) {
          // It landed after all. Let `change` finish the job; if it somehow
          // does not fire, keep polling rather than discarding the pick.
          resumeTimer = window.setTimeout(check, FILE_PICKER_POLL_MS);
          return;
        }
        waited += FILE_PICKER_POLL_MS;
        if (waited >= FILE_PICKER_GIVE_UP_MS) {
          traceOpen("picker: gave up waiting for a file", { waitedMs: waited });
          settle(null);
          return;
        }
        resumeTimer = window.setTimeout(check, FILE_PICKER_POLL_MS);
      };
      resumeTimer = window.setTimeout(check, delayMs);
    };

    const onLeave = () => {
      leftForeground = true;
    };

    const onResume = () => {
      if (!leftForeground) return;
      // Long on purpose: Android SAF can deliver `change` well after the
      // activity has resumed, and a short timer cancelled textbook PDFs
      // while tiny markdown files still won the race.
      armResume(FILE_PICKER_RESUME_MS);
    };

    const onPointer = () => {
      /*
       * Only meaningful *after* the picker has actually taken the foreground.
       *
       * This used to set `leftForeground` itself, which made any tap before the
       * picker appeared look like a return from it. Android's SAF can take a
       * second to cover the WebView, so an impatient second tap armed the
       * 400 ms timer, the pick settled `null` while the picker was still
       * opening, and the file the reader went on to choose was dropped on the
       * floor with no error — the picker closed and nothing happened.
       *
       * A pointer only tells us the picker is gone if we know it was there.
       */
      if (!leftForeground) return;
      armResume(FILE_PICKER_POINTER_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") onLeave();
      else if (document.visibilityState === "visible") onResume();
    };

    input.addEventListener("cancel", () => {
      traceOpen("picker: cancel event");
      settle(null);
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        settle(null);
        return;
      }
      chosen = true;
      window.clearTimeout(resumeTimer);
      traceOpen("picker: file chosen", { name: file.name, size: file.size });
      read(file).then(
        (value) => {
          traceOpen("picker: file read", { name: file.name });
          settle(value);
        },
        (cause) => {
          traceOpen("picker: read FAILED", {
            name: file.name,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          fail(cause);
        },
      );
    });

    window.addEventListener("focus", onResume);
    window.addEventListener("blur", onLeave);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("visibilitychange", onVisibility);

    document.body.append(input);
    input.click();
  });
}

function readPickedText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return readBlobBytes(file).then((bytes) => new TextDecoder().decode(bytes));
}

/**
 * Ask for a markdown file and read it as text.
 *
 * Resolves `null` when the picker is dismissed. Android's file activity does
 * not fire `cancel` on back-swipe or app switch, so {@link pickFromHiddenInput}
 * also settles null once the WebView is in front again without a file.
 */
export function pickMarkdownFile(): Promise<OpenedMarkdown | null> {
  return pickFromHiddenInput(MARKDOWN_ACCEPT, async (file) => ({
    name: file.name,
    source: await readPickedText(file),
  }));
}

/**
 * Ask for a `.lc-ink.json` sidecar and read it.
 *
 * Same dismiss contract as {@link pickMarkdownFile}. Bytes, not text: a
 * sidecar may be gzipped, and `File.text()` on compressed bytes yields
 * mojibake rather than an error.
 */
export function pickSidecarFile(): Promise<{ name: string; text: string } | null> {
  return pickFromHiddenInput(
    ".json,.gz,application/json,application/gzip",
    async (file) => ({
      name: file.name,
      text: await textFromMaybeGzip(new Uint8Array(await readBlobBytes(file))),
    }),
  );
}

export interface AnnotateSidecar {
  v: 1;
  sourceName: string;
  contentHash: string;
  board: BoardBlob;
  /** Marks anchored to the document — see `docFootnotes`. */
  footnotes?: DocFootnote[];
  /**
   * The page width the annotations were made at, in scene units.
   *
   * Ink is stored in scene coordinates and region footnotes in page
   * coordinates; neither follows text that reflows. The pad pins a document's
   * frame width once anything has been drawn on it, so within the app this
   * never drifts — but a sidecar can be carried to another device with a
   * different screen, and there the same file may lay out at a different
   * column. Recording the width is what lets {@link sidecarWidthWarning} say so
   * rather than leaving the writer to wonder why a mark sits off its figure.
   */
  frameWidth?: number;
}

/**
 * Warn when a sidecar was drawn at a different page width than this one.
 *
 * Text footnotes are fine either way — they follow the words. Ink and region
 * marks are not, so the message names them specifically instead of implying
 * everything has moved.
 */
export function sidecarWidthWarning(
  sidecar: AnnotateSidecar,
  frameWidth: number | null,
): string | null {
  const was = sidecar.frameWidth;
  if (!was || !frameWidth) return null;
  if (Math.abs(was - frameWidth) < 2) return null;
  return (
    `These annotations were made on a ${Math.round(was)}px-wide page and this one is ` +
    `${Math.round(frameWidth)}px. Quotes will follow the text; pen marks and ` +
    `highlights are placed by position and may sit off their target.`
  );
}

export function buildAnnotateSidecar(input: {
  sourceName: string;
  contentHash: string;
  board: BoardBlob;
  footnotes?: readonly DocFootnote[];
  frameWidth?: number | null;
}): AnnotateSidecar {
  return {
    v: 1,
    sourceName: input.sourceName,
    contentHash: input.contentHash,
    board: input.board,
    ...(input.footnotes && input.footnotes.length > 0
      ? { footnotes: [...input.footnotes] }
      : {}),
    ...(input.frameWidth ? { frameWidth: Math.round(input.frameWidth) } : {}),
  };
}

/**
 * File name a sidecar should be saved under, beside its markdown.
 *
 * The `.gz` is honest rather than decorative: the file really is gzip, and a
 * name that said `.json` would have every tool that opens it by extension fail
 * on the first byte. Import sniffs the content, so a sidecar written either way
 * still opens either way.
 */
export function sidecarNameFor(sourceName: string, compressed = canGzip()): string {
  return `${sourceName}.lc-ink.json${compressed ? ".gz" : ""}`;
}

/** Parse a sidecar, returning null for anything that is not one. */
export function readAnnotateSidecar(raw: string): AnnotateSidecar | null {
  try {
    const parsed = JSON.parse(raw) as AnnotateSidecar;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.sourceName !== "string") return null;
    if (parsed.board?.v !== 1 || !Array.isArray(parsed.board.elements)) return null;
    return { ...parsed, footnotes: sanitizeFootnotes(parsed.footnotes) };
  } catch {
    return null;
  }
}

/**
 * Hand the annotation set to the writer as a file they can keep.
 *
 * Gzipped where the browser can: the JSON is one field name per coordinate
 * repeated tens of thousands of times, so an annotated page goes from ~78 KB to
 * ~2 KB. That is the difference between a file someone can mail themselves and
 * one they cannot.
 */
export async function exportAnnotateSidecar(sidecar: AnnotateSidecar): Promise<void> {
  const compressed = canGzip();
  const bytes = await gzipText(JSON.stringify(sidecar));
  const blob = new Blob([bytes], {
    type: compressed ? "application/gzip" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sidecarNameFor(sidecar.sourceName, compressed);
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately races the download in some WebViews.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Download an owned note as a real `.md` file.
 *
 * The only way a note written here becomes a file anywhere else — there is no
 * filesystem handle and deliberately no Tauri fs plugin, so this is a plain
 * blob download like the sidecar export beside it. Unlike that one it carries
 * no ink: this is the text, for reading somewhere that is not this app.
 */
export function exportMarkdownNote(name: string, source: string): void {
  const blob = new Blob([source], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Ask for a document of any kind the pad understands, and read it.
 *
 * Same dismiss contract as {@link pickMarkdownFile}.
 */
export function pickDocumentFile(): Promise<OpenedDocument | null> {
  return pickFromHiddenInput(documentPickerAccept(), async (file) => {
    const bytes = await readBlobBytes(file);
    const docType = docTypeForPicked(file, bytes);
    const name = file.name || fallbackPickedName(docType);
    if (isTextDocType(docType)) {
      return { name, docType, text: new TextDecoder().decode(bytes) };
    }
    return { name, docType, bytes };
  });
}
