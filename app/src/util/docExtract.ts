/**
 * Extract page text for the daemon document index.
 *
 * Uploads extracted text, never the raw PDF/EPUB bytes.
 */

import type { DocType } from "./annotateStore";
import { readEpub } from "./epub";
import { loadPdfJs } from "../modes/PdfDocument";
import { webPagesFromMarks, type MarkLike } from "./webMarkPages";

/**
 * Told how far extraction has got, as it goes.
 *
 * Reported in **pages**, deliberately — indexing counts pages and embedding
 * counts chunks, and blending the two into one number hides the distinction
 * between chunking a document and giving its chunks a model's vectors. Two
 * jobs, two units.
 *
 * `total` can be zero when nothing has said how much there is yet; a caller
 * showing a ring should sweep rather than invent a percentage.
 */
export type ExtractProgress = (done: number, total: number) => void;

export interface ExtractedPage {
  page: number;
  text: string;
  heading?: string;
  scope?: string;
}

const PAGE_TEXT_ASK_CHARS = 2000;

let pageCache: { hash: string; pages: ExtractedPage[] } | null = null;

export function rememberExtractedPages(hash: string, pages: ExtractedPage[]): void {
  pageCache = { hash, pages };
}

export function extractedPagesFor(hash: string): ExtractedPage[] | null {
  return pageCache && pageCache.hash === hash ? pageCache.pages : null;
}

export function pageTextForAsk(hash: string, page: number | null | undefined): string {
  const pages = extractedPagesFor(hash);
  if (!pages || pages.length === 0) return "";
  const wanted = page && page > 0 ? page : 1;
  const match = pages.find((entry) => entry.page === wanted) ?? pages[0];
  const text = match.text.trim();
  if (text.length <= PAGE_TEXT_ASK_CHARS) return text;
  return `${text.slice(0, PAGE_TEXT_ASK_CHARS)}\n…`;
}

export async function extractDocumentPages(input: {
  docType: DocType;
  name: string;
  text: string;
  bytes?: ArrayBuffer | null;
  /**
   * The reader's marks, used only for a web page — see {@link webPagesFromMarks}.
   *
   * Every other kind was deliberately opened, so all of it is indexed. A page
   * was not: it is mostly navigation and promotion, and the part that was meant
   * is the part a selection block was drawn around.
   */
  marks?: readonly MarkLike[];
  /** Called per page while a long document is read. See {@link ExtractProgress}. */
  onProgress?: ExtractProgress;
}): Promise<ExtractedPage[]> {
  if (input.docType === "pdf") {
    if (!input.bytes) return [];
    return extractPdfPages(input.bytes, input.onProgress);
  }
  if (input.docType === "epub") {
    if (!input.bytes) return [];
    return extractEpubPages(input.bytes, input.onProgress);
  }
  if (input.docType === "web") {
    const marked = webPagesFromMarks(input.marks ?? []);
    if (marked.length > 0) {
      // A page's extraction is instantaneous; say so rather than leaving a ring
      // sweeping at nothing.
      input.onProgress?.(marked.length, marked.length);
      return marked.map((entry) => ({
        page: entry.page,
        text: entry.text,
        heading: headingFrom(entry.text) ?? input.name,
        scope: input.name,
      }));
    }
    // Nothing marked yet, so there is nothing to prefer — index the page and let
    // the chip say that marking passages first would index less noise.
    const text = htmlToText(input.text).trim();
    if (!text) return [];
    input.onProgress?.(1, 1);
    return [
      {
        page: 1,
        text,
        heading: headingFrom(text) ?? input.name,
        scope: input.name,
      },
    ];
  }
  const text = input.text.trim();
  if (!text) return [];
  input.onProgress?.(1, 1);
  return [
    {
      page: 1,
      text,
      heading: headingFrom(text) ?? input.name,
    },
  ];
}

async function extractPdfPages(
  bytes: ArrayBuffer,
  onProgress?: ExtractProgress,
): Promise<ExtractedPage[]> {
  const pdfjs = await loadPdfJs();
  // Share the viewer's worker — a second workerPort hangs getDocument —
  // so yield between pages or flick-scroll stalls behind getTextContent.
  const task = pdfjs.getDocument({
    data: bytes.slice(0),
    standardFontDataUrl: new URL("standard_fonts/", document.baseURI).href,
    cMapUrl: new URL("cmaps/", document.baseURI).href,
    cMapPacked: true,
  });
  const pages: ExtractedPage[] = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        pages.push({
          page: n,
          text,
          heading: headingFrom(text),
          scope: `p${n}`,
        });
      }
      /*
       * Every page, not every page that had text on it.
       *
       * A scanned plate or a blank leaf yields nothing and pushes no entry, so
       * counting what was kept would make the bar stall on exactly the
       * documents that take longest.
       */
      onProgress?.(n, doc.numPages);
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined" || !window.requestAnimationFrame) {
          resolve();
          return;
        }
        window.requestAnimationFrame(() => resolve());
      });
    }
  } finally {
    void task.destroy();
  }
  return pages;
}

function extractEpubPages(
  bytes: ArrayBuffer,
  onProgress?: ExtractProgress,
): ExtractedPage[] {
  const book = readEpub(bytes);
  return book.chapters.flatMap((chapter, index) => {
    onProgress?.(index + 1, book.chapters.length);
    const text = htmlToText(chapter.html).trim();
    if (!text) return [];
    return [
      {
        page: index + 1,
        text,
        heading: headingFrom(text) ?? chapter.href,
        scope: chapter.href,
      },
    ];
  });
}

function htmlToText(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return (holder.innerText || holder.textContent || "").replace(/\s+\n/g, "\n").trim();
}

function headingFrom(text: string): string | undefined {
  for (const line of text.split(/\n/).slice(0, 8)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const title = trimmed.replace(/^#+\s*/, "").trim();
      if (title) return title;
    }
  }
  const first = text.trim().split(/\n/)[0]?.trim();
  if (first && first.length > 0 && first.length < 80) return first;
  return undefined;
}
