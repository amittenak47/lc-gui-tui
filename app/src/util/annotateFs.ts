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
import { sanitizeFootnotes, type DocFootnote } from "./docFootnotes";
import { canGzip, gzipText, textFromMaybeGzip } from "./gzip";
import type { DocType } from "./annotateStore";

export { CODE_SOURCE_MAX_CHARS, languageForName } from "./codeLanguages";

/** Extensions the picker offers, and what we accept when one is dropped in. */
export const MARKDOWN_ACCEPT = ".md,.markdown,.mdown,.mkd,text/markdown";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

const CODE_ACCEPT = codeAcceptExtensions().join(",");

/** Everything the document pad will open. */
export const DOCUMENT_ACCEPT = [
  MARKDOWN_ACCEPT,
  ".pdf,application/pdf",
  ".epub,application/epub+zip",
  CODE_ACCEPT,
  "text/plain",
].join(",");

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

/** True when the pad stores this type as a string in the library entry. */
export function isTextDocType(docType: DocType): boolean {
  return docType === "markdown" || docType === "code" || docType === "web";
}

/**
 * Ask for a markdown file and read it as text.
 *
 * Resolves `null` when the picker is dismissed. There is no reliable cancel
 * event on a file input — browsers fire `cancel` inconsistently and some never
 * fire anything — so the caller gets `null` only on an explicit cancel it can
 * observe, and otherwise the promise settles when a file arrives. The input is
 * removed either way once it resolves.
 */
export function pickMarkdownFile(): Promise<OpenedMarkdown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = MARKDOWN_ACCEPT;
    // Off-screen rather than `display: none`: a hidden input is ignored by
    // some WebViews when `click()` is called programmatically.
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: OpenedMarkdown | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((source) => finish({ name: file.name, source }))
        .catch((cause) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(cause);
        });
    });

    document.body.append(input);
    input.click();
  });
}

/**
 * Ask for a `.lc-ink.json` sidecar and read it.
 *
 * Same shape as {@link pickMarkdownFile} — see the note there about why cancel
 * resolves rather than rejects.
 */
export function pickSidecarFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.gz,application/json,application/gzip";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      // Bytes, not text: a sidecar may be gzipped, and `File.text()` on
      // compressed bytes yields mojibake rather than an error.
      file
        .arrayBuffer()
        .then((buffer) => textFromMaybeGzip(new Uint8Array(buffer)))
        .then((text) => finish({ name: file.name, text }))
        .catch((cause) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(cause);
        });
    });

    document.body.append(input);
    input.click();
  });
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
 * Ask for a document of any kind the pad understands, and read it.
 *
 * Same cancel contract as {@link pickMarkdownFile} — see the note there.
 */
export function pickDocumentFile(): Promise<OpenedDocument | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = DOCUMENT_ACCEPT;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: OpenedDocument | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      reject(cause);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const docType = docTypeForName(file.name);
      if (isTextDocType(docType)) {
        file
          .text()
          .then((text) => finish({ name: file.name, docType, text }))
          .catch(fail);
        return;
      }
      file
        .arrayBuffer()
        .then((bytes) => finish({ name: file.name, docType, bytes }))
        .catch(fail);
    });

    document.body.append(input);
    input.click();
  });
}
