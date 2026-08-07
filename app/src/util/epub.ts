/**
 * Reading an EPUB far enough to put it on the page.
 *
 * An EPUB is a ZIP of XHTML with a manifest, so this is an unzip, two XML
 * lookups and a sanitise — not a reader. `epub.js` was the obvious alternative
 * and does much more than is wanted here: it owns pagination, it renders into
 * iframes, and it keeps its own view of where you are in the book. All three
 * fight the thing this pad is: one scrolling column that the board camera
 * moves, with ink on top that has to stay on the words it was drawn on.
 *
 * Chapters are concatenated into one document rather than paged. That is what
 * lets a footnote anchor be a plain character offset — see `docAnchors` — and
 * it is why a spine location does not need to be stored separately: with the
 * whole book in one stream, the offset already names the chapter.
 */

import DOMPurify from "dompurify";
import { unzipSync, strFromU8 } from "fflate";

export interface EpubChapter {
  /** Manifest href, kept for ordering and for debugging a book that renders oddly. */
  href: string;
  /** Sanitised body HTML. */
  html: string;
}

export interface EpubBook {
  title: string;
  chapters: EpubChapter[];
}

/** Resolve an href that is relative to the file it appeared in. */
export function resolveHref(base: string, href: string): string {
  const clean = href.split("#")[0];
  if (!clean) return "";
  const stack = base.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function parseXml(text: string, label: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(`this EPUB's ${label} is not valid XML`);
  }
  return doc;
}

/** Path of the package document, from the one file an EPUB guarantees. */
export function opfPathFrom(containerXml: string): string {
  const doc = parseXml(containerXml, "container");
  const path = doc.querySelector("rootfile")?.getAttribute("full-path");
  if (!path) throw new Error("this EPUB has no package document");
  return path;
}

interface Spine {
  title: string;
  /** Manifest hrefs, resolved against the package document, in reading order. */
  hrefs: string[];
  /** Every manifest entry by resolved path, for rewriting image sources. */
  media: Map<string, string>;
}

export function parsePackage(opfXml: string, opfPath: string): Spine {
  const doc = parseXml(opfXml, "package document");
  const title = doc.querySelector("metadata title")?.textContent?.trim() || "";

  const byId = new Map<string, { href: string; type: string }>();
  const media = new Map<string, string>();
  for (const item of Array.from(doc.querySelectorAll("manifest > item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    const type = item.getAttribute("media-type") ?? "";
    const resolved = resolveHref(opfPath, href);
    byId.set(id, { href: resolved, type });
    media.set(resolved, type);
  }

  const hrefs: string[] = [];
  for (const ref of Array.from(doc.querySelectorAll("spine > itemref"))) {
    // `linear="no"` is the spec's way of saying "not part of the reading
    // order" — cover art, ad pages. Skipping them is why the book opens on
    // chapter one rather than on a full-page image.
    if (ref.getAttribute("linear") === "no") continue;
    const entry = byId.get(ref.getAttribute("idref") ?? "");
    if (entry) hrefs.push(entry.href);
  }
  return { title, hrefs, media };
}

/**
 * Body HTML of a chapter, with everything executable taken out.
 *
 * An EPUB is an untrusted document however it got here — more so than a
 * markdown file, because it ships its own stylesheets and can ship scripts.
 * Styles go as well as scripts: a book's CSS is written for a paginated reader
 * with its own page box, and letting it near this column produces text at
 * random sizes over the ink rather than under it.
 */
export function chapterHtml(xhtml: string): string {
  const doc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  const body = doc.querySelector("body") ?? doc.documentElement;
  return DOMPurify.sanitize(body?.innerHTML ?? "", {
    FORBID_TAGS: ["script", "style", "link", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}

/** Images live inside the zip, so their `src` has to be rewritten to reach them. */
function inlineImages(
  html: string,
  chapterHref: string,
  files: Record<string, Uint8Array>,
  media: Map<string, string>,
): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  for (const image of Array.from(holder.querySelectorAll("img"))) {
    const src = image.getAttribute("src");
    if (!src || /^(https?:|data:)/i.test(src)) continue;
    const path = resolveHref(chapterHref, src);
    const bytes = files[path];
    if (!bytes) {
      image.remove();
      continue;
    }
    const type = media.get(path) || "image/jpeg";
    image.setAttribute("src", `data:${type};base64,${base64Of(bytes)}`);
  }
  return holder.innerHTML;
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a full-page scan blows the
  // argument limit long before it blows memory.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Unzip, walk the spine, and hand back chapters ready to render. */
export function readEpub(bytes: ArrayBuffer): EpubBook {
  const files = unzipSync(new Uint8Array(bytes));
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error("this file is not an EPUB (no container.xml)");
  const opfPath = opfPathFrom(strFromU8(container));
  const opf = files[opfPath];
  if (!opf) throw new Error(`this EPUB names a package document it does not contain`);
  const spine = parsePackage(strFromU8(opf), opfPath);

  const chapters: EpubChapter[] = [];
  for (const href of spine.hrefs) {
    const raw = files[href];
    if (!raw) continue;
    try {
      const html = inlineImages(chapterHtml(strFromU8(raw)), href, files, spine.media);
      if (html.trim()) chapters.push({ href, html });
    } catch {
      // One unparseable chapter is not a reason to refuse the book — skip it
      // and let the reader see the rest.
    }
  }
  if (chapters.length === 0) throw new Error("this EPUB has no readable chapters");
  return { title: spine.title, chapters };
}
