/**
 * Capture a web page as the annotate paper — same contract as EPUB.
 *
 * Tauri: hidden webview runs the page, then we serialize the post-JS DOM.
 * Vite preview: HTTP GET of the server body (JS apps stay a shell there).
 * Scripts never re-run in our origin.
 */

import DOMPurify from "dompurify";

import { isSafeExternalUrl, normalizeExternalUrl } from "./openExternal";
import { absolutizeCssUrls, scopeCss } from "./webPageCss";

/** Inlined CSS/images after capture; keep in sync with Rust `PAGE_MAX_BYTES`. */
export const PAGE_MAX_BYTES = 8_000_000;

export const WEB_HOME = "https://www.google.com/";

/** Header label: host only. Full URL lives in the omnibox. */
export function hostLabelFromUrl(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    return host.replace(/^www\./i, "") || raw;
  } catch {
    return raw;
  }
}

export interface FetchedWebPage {
  url: string;
  title: string;
  html: string;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let invokeLoader: Promise<Invoke | null> | null = null;

function loadInvoke(): Promise<Invoke | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as Invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

export function titleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return title;
}

export function absolutizeUrl(base: string, href: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * Executable bits out. Styles stay so a snapshot can lay out; a wrapper-only
 * DOM is flattened so marquee hits real blocks, not one 17k-px shell.
 */
export function sanitizeWebHtml(html: string, baseUrl: string): string {
  const cleaned = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
    ADD_TAGS: ["style", "link"],
    ADD_ATTR: ["style"],
  });
  if (typeof document === "undefined") return cleaned;
  const holder = document.createElement("div");
  // Fragment innerHTML on a div drops <head> metadata in some engines and
  // keeps modulepreload in Chrome. Parse as a document so CSS links survive
  // and we can strip the JS ones.
  if (typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(cleaned, "text/html");
    for (const node of Array.from(parsed.head.childNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.tagName === "STYLE" || node.tagName === "LINK") {
        holder.appendChild(document.importNode(node, true));
      }
    }
    for (const node of Array.from(parsed.body.childNodes)) {
      holder.appendChild(document.importNode(node, true));
    }
  } else {
    holder.innerHTML = cleaned;
  }
  // Stylesheets stay. modulepreload / preload-as-script would fetch remote
  // JS from our origin and CORS-fail (WordPress interactivity modules).
  for (const link of Array.from(holder.querySelectorAll("link"))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet")) continue;
    link.remove();
  }
  for (const node of Array.from(holder.querySelectorAll("[hidden], [aria-hidden='true']"))) {
    node.remove();
  }
  flattenWebSnapshot(holder);
  for (const style of Array.from(holder.querySelectorAll("style"))) {
    const raw = style.textContent || "";
    if (raw.length > INLINE_STYLE_CAP) {
      style.remove();
      continue;
    }
    style.textContent = scopeCss(absolutizeCssUrls(raw, baseUrl));
  }
  promoteLazyImages(holder);
  for (const node of Array.from(holder.querySelectorAll("[style]"))) {
    const raw = node.getAttribute("style");
    if (!raw) continue;
    node.setAttribute(
      "style",
      raw.replace(/position\s*:\s*(fixed|sticky)/gi, "position:static"),
    );
  }
  for (const node of Array.from(holder.querySelectorAll("[href], [src]"))) {
    const attr = node.hasAttribute("href") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw || /^(https?:|data:|mailto:|#)/i.test(raw)) continue;
    node.setAttribute(attr, absolutizeUrl(baseUrl, raw));
  }
  for (const node of Array.from(holder.querySelectorAll("[srcset]"))) {
    const raw = node.getAttribute("srcset");
    if (!raw) continue;
    node.setAttribute("srcset", absolutizeSrcset(raw, baseUrl));
  }
  return holder.innerHTML;
}

const LAZY_SRC_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy"];

function isPlaceholderSrc(src: string): boolean {
  const trimmed = src.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("data:")) return true;
  return /placeholder|lazy|spacer|blank/i.test(trimmed);
}

/**
 * WordPress lazysizes leaves a blank SVG in `src` and the file in `data-src`.
 * Page JS never runs here, so swap on the node itself (sanitize and the live paper).
 * Never rewrite http(s) through `__lc-web-fetch` — that buffer-stormed Cursor.
 */
export function promoteLazyImages(root: ParentNode): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    const lazy = LAZY_SRC_ATTRS.map((name) => img.getAttribute(name)?.trim()).find(
      (value) => value && /^https?:/i.test(value),
    );
    if (lazy && isPlaceholderSrc(src)) {
      img.setAttribute("src", lazy);
    }
    const srcset =
      img.getAttribute("data-srcset") ||
      img.getAttribute("data-lazy-srcset") ||
      img.getAttribute("srcset");
    if (srcset) img.setAttribute("srcset", srcset);
    const sizes = img.getAttribute("data-sizes") || img.getAttribute("data-lazy-sizes");
    if (sizes && !img.getAttribute("sizes")) img.setAttribute("sizes", sizes);
    img.classList.remove("lazyload", "lazyloading", "lazy");
    img.setAttribute("loading", "eager");
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const source of Array.from(root.querySelectorAll("source"))) {
    const srcset =
      source.getAttribute("data-srcset") || source.getAttribute("srcset");
    if (srcset) source.setAttribute("srcset", srcset);
  }
}

function absolutizeSrcset(srcset: string, baseUrl: string): string {
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const bits = trimmed.split(/\s+/);
      const url = bits[0] ?? "";
      const rest = bits.slice(1).join(" ");
      if (!url || /^(https?:|data:)/i.test(url)) return trimmed;
      return `${absolutizeUrl(baseUrl, url)}${rest ? ` ${rest}` : ""}`;
    })
    .join(", ");
}

/** Skip walking sheets bigger than this — Google/NVIDIA CSS froze the UI thread. */
const INLINE_STYLE_CAP = 80_000;

/**
 * Drop `<link rel=stylesheet>` (they style the whole app). Scope small inline
 * `<style>` only. Never fetch remote CSS here.
 */
export async function isolateWebCss(html: string, baseUrl: string): Promise<string> {
  if (typeof document === "undefined") return html;
  const holder = document.createElement("div");
  if (typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const node of Array.from(parsed.head.childNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.tagName === "STYLE" || node.tagName === "LINK") {
        holder.appendChild(document.importNode(node, true));
      }
    }
    for (const node of Array.from(parsed.body.childNodes)) {
      holder.appendChild(document.importNode(node, true));
    }
  } else {
    holder.innerHTML = html;
  }
  for (const link of Array.from(holder.querySelectorAll("link"))) link.remove();
  for (const style of Array.from(holder.querySelectorAll("style"))) {
    const raw = style.textContent || "";
    if (raw.length > INLINE_STYLE_CAP) {
      style.remove();
      continue;
    }
    style.textContent = scopeCss(absolutizeCssUrls(raw, baseUrl));
  }
  return holder.innerHTML;
}

const FLATTEN_ONCE = new Set(["HTML", "BODY", "DIV", "SPAN", "CENTER", "MAIN", "ARTICLE"]);

/** Unwrap single generic shells so `.lc-md-ink-doc > *` are real blocks. */
export function flattenWebSnapshot(holder: HTMLElement): void {
  for (let step = 0; step < 24; step += 1) {
    if (holder.children.length !== 1) return;
    const only = holder.children[0];
    if (!(only instanceof HTMLElement)) return;
    if (!FLATTEN_ONCE.has(only.tagName)) return;
    holder.replaceChildren(...Array.from(only.childNodes));
  }
}

async function fetchViaViteProxy(url: string): Promise<{ url: string; html: string }> {
  const response = await fetch(`./__lc-web-fetch?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `the page returned HTTP ${response.status}`);
  }
  const finalUrl = response.headers.get("x-lc-final-url") || url;
  const html = await response.text();
  return { url: finalUrl, html };
}

export async function fetchWebPage(raw: string): Promise<FetchedWebPage> {
  const url = normalizeExternalUrl(raw);
  if (!url || !isSafeExternalUrl(url)) {
    throw new Error("that does not look like an http(s) address");
  }

  let fetched: { url: string; html: string };
  if (isTauriRuntime()) {
    try {
      const { captureRenderedPage } = await import("./webPageCapture");
      fetched = await captureRenderedPage(url);
    } catch {
      const invoke = await loadInvoke();
      if (invoke) {
        fetched = await invoke<{ url: string; html: string }>("fetch_html", { url });
      } else {
        fetched = await fetchViaViteProxy(url);
      }
    }
  } else {
    fetched = await fetchViaViteProxy(url);
  }

  if (fetched.html.length > PAGE_MAX_BYTES) {
    throw new Error("this page is too large to annotate here");
  }

  const html = await isolateWebCss(sanitizeWebHtml(fetched.html, fetched.url), fetched.url);
  const title = titleFromHtml(fetched.html) || fetched.url;
  return { url: fetched.url, title, html };
}
