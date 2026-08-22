/**
 * Capture a web page as the annotate paper — same contract as EPUB.
 *
 * Tauri: hidden webview runs the page, then we serialize the post-JS DOM.
 * Vite preview: HTTP GET of the server body (JS apps stay a shell there).
 * Scripts never re-run in our origin.
 */

import DOMPurify from "dompurify";

import { liveWebviewSupported } from "./liveWebviewSupport";
import { isSafeExternalUrl, normalizeExternalUrl } from "./openExternal";
import { absolutizeCssUrls, scopeCss } from "./webPageCss";
import { DEFAULT_WEB_RENDER_MODE, type WebRenderMode } from "./webRenderMode";

/** Inlined CSS/images after capture; keep in sync with Rust `PAGE_MAX_BYTES`. */
export const PAGE_MAX_BYTES = 8_000_000;

export const WEB_HOME = "https://www.google.com/";

/** Match the hidden capture webview so Google's desktop CSS lays out in-box. */
export const WEB_PAGE_W = 1280;
export const WEB_PAGE_W_MAX = 2400;

/** Pad and capture share this width so @media and flex see the same box. */
export function webPageWidthForViewport(cssWidth: number): number {
  if (!Number.isFinite(cssWidth) || cssWidth < 1) return WEB_PAGE_W;
  const inset = cssWidth < 720 ? 24 : 80;
  return Math.round(Math.max(360, Math.min(WEB_PAGE_W_MAX, cssWidth - inset)));
}

/** Fetch/Vite path only. Capture-inlined CSS is the payload and must survive. */
export const FETCH_STYLE_CAP = 80_000;

/**
 * How the paper under the ink was made.
 *
 * `reader` — the article, extracted from the captured DOM. The good case.
 * `capture` — the whole page, post-JavaScript, with its CSS scoped and inlined.
 *   Reached when the page is not an article.
 * `fetch` — raw GET, the page's JS never ran. Reached when capture failed.
 */
export type WebHtmlSource = "capture" | "fetch" | "reader";

export function styleTagStats(html: string): { count: number; max: number; total: number } {
  const tags = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  let max = 0;
  let total = 0;
  for (const tag of tags) {
    const inner = tag.replace(/^<style\b[^>]*>/i, "").replace(/<\/style>$/i, "");
    total += inner.length;
    if (inner.length > max) max = inner.length;
  }
  return { count: tags.length, max, total };
}

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
  source: WebHtmlSource;
  /**
   * Why the rendered capture was not used, when it was not.
   *
   * Falling back is not the plan — the capture runs the page's JS in a hidden
   * webview and serialises what it produced, which is the whole reason a
   * script-heavy page renders at all. So a fetch is a *failure*, and it used
   * to be one you could only see in the console.
   */
  note?: string;
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
/**
 * Make what is left of the page's chrome look right and do nothing.
 *
 * A snapshot is a picture of a page, so its buttons should be shaped like
 * buttons and its search box should be a box. None of them should be reachable
 * by a keyboard or able to send anything anywhere.
 */
function inertInteractive(holder: HTMLElement): void {
  // A form is the only element here with behaviour of its own — Enter in a
  // field submits it. Keep the box, drop the verb.
  for (const form of Array.from(holder.querySelectorAll("form"))) {
    const div = holder.ownerDocument.createElement("div");
    for (const attr of Array.from(form.attributes)) {
      if (/^(action|method|target|enctype|novalidate|name)$/i.test(attr.name)) continue;
      try {
        div.setAttribute(attr.name, attr.value);
      } catch {
        /* a name the parser accepted and the setter will not */
      }
    }
    while (form.firstChild) div.appendChild(form.firstChild);
    form.replaceWith(div);
  }
  for (const node of Array.from(
    holder.querySelectorAll("button, input, textarea, select"),
  )) {
    // Out of the tab order, and carrying nothing that could be submitted.
    node.setAttribute("tabindex", "-1");
    node.setAttribute("aria-disabled", "true");
    for (const attr of ["name", "formaction", "formmethod", "autofocus", "required"]) {
      node.removeAttribute(attr);
    }
    if (node instanceof holder.ownerDocument.defaultView!.HTMLInputElement) {
      node.setAttribute("readonly", "");
    }
  }
}

export function sanitizeWebHtml(
  html: string,
  baseUrl: string,
  source: WebHtmlSource = "fetch",
): string {
  const cleaned = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    /*
     * `form` goes; the controls stay.
     *
     * Deleting `button` and `input` outright was costing the snapshot most of
     * its face. DOMPurify unwraps a forbidden tag rather than dropping its
     * children, so `<button class="cta"><svg/>Start</button>` came through as a
     * bare glyph and a word — the element every one of the page's own rules was
     * written against had gone, and with it the shape, the fill and the
     * padding. Inputs, having no children, vanished entirely: that is the grey
     * blob where Google's search box should be.
     *
     * Keeping them costs nothing here. `script` is still forbidden and
     * DOMPurify strips event handlers, so nothing in a snapshot can run. The
     * one live path left was a `form` submitting on Enter — so the form itself
     * is turned into a plain `div` below, which keeps its classes for layout
     * and has no submit behaviour to speak of.
     */
    FORBID_TAGS: ["script", "iframe", "object", "embed"],
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
  // Stylesheets stay *here* — `isolateWebCss` fetches and scopes them next.
  // modulepreload / preload-as-script would fetch remote JS from our origin and
  // CORS-fail (WordPress interactivity modules).
  for (const link of Array.from(holder.querySelectorAll("link"))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet")) continue;
    link.remove();
  }
  /*
   * Trust the mark the capture left, not the attribute (§4b).
   *
   * `aria-hidden="true"` says "skip me, screen reader". It does not say
   * invisible — pages put it on decorative but visible things, and icons most
   * of all, which is why a frozen sidebar arrived with its glyphs missing.
   * `serializeCurrentDocument` now stamps `data-lc-hidden` from the computed
   * style, which is the only thing that actually knows.
   *
   * The fetch path never ran that pass and has no computed styles to consult,
   * so it keeps the bare `[hidden]` rule — a plain attribute that does mean
   * invisible.
   */
  const hiddenSelector =
    source === "fetch" ? "[hidden], [data-lc-hidden]" : "[data-lc-hidden]";
  for (const node of Array.from(holder.querySelectorAll(hiddenSelector))) {
    node.remove();
  }
  inertInteractive(holder);
  flattenWebSnapshot(holder);
  for (const style of Array.from(holder.querySelectorAll("style"))) {
    const raw = style.textContent || "";
    if (source === "fetch" && raw.length > FETCH_STYLE_CAP) {
      style.remove();
      continue;
    }
    style.textContent = scopeCss(absolutizeCssUrls(raw, baseUrl));
  }
  promoteLazyImages(holder);
  /*
   * Put pinned chrome back where it was (§4c).
   *
   * `fixed` paints against the viewport, so flattening it to `static` drops it
   * wherever its tag sits in the markup — which for a cookie bar or a floating
   * header is a band across the middle of the article. The capture recorded
   * each one's real document offset, so it can be placed instead of guessed.
   *
   * `sticky` needs no offset: it is in the flow already, and `static` leaves it
   * exactly where it was resting.
   */
  for (const node of Array.from(holder.querySelectorAll("[data-lc-pin-top]"))) {
    const top = node.getAttribute("data-lc-pin-top");
    const left = node.getAttribute("data-lc-pin-left");
    node.removeAttribute("data-lc-pin-top");
    node.removeAttribute("data-lc-pin-left");
    if (top == null) continue;
    const style = (node.getAttribute("style") || "").replace(
      /position\s*:\s*(fixed|sticky|absolute|static)\s*;?/gi,
      "",
    );
    node.setAttribute(
      "style",
      `${style};position:absolute;top:${Number(top) || 0}px;left:${Number(left) || 0}px`,
    );
  }
  for (const node of Array.from(holder.querySelectorAll("[style]"))) {
    const raw = node.getAttribute("style");
    if (!raw || /position\s*:\s*absolute/i.test(raw)) continue;
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

/**
 * Bring `<link rel=stylesheet>` in as scoped `<style>`, or drop it.
 *
 * A left-alone link is worse than either: cross-origin sheets are not readable
 * through the CSSOM, so nothing here can scope them, and an unscoped sheet
 * paints the *app* — Wikipedia's `body` rule over our header. Dropping them
 * outright was the safe answer and it is what made a captured page look like
 * 1994: Wikipedia keeps almost none of its appearance in inline `<style>`, so
 * cutting the links cut the page's whole design and left raw HTML behind.
 *
 * Fetching them puts the design back with the text still intact, which is the
 * point — the words are already perfect, so nothing here should ever be
 * re-derived from pixels.
 *
 * Capture: `<style>` is the inlined payload — keep and scope it, no size cap.
 * Fetch: drop huge inline sheets so GET HTML cannot freeze the UI thread.
 */
export async function isolateWebCss(
  html: string,
  baseUrl: string,
  source: WebHtmlSource = "fetch",
): Promise<string> {
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
  await inlineLinkedStyles(holder, baseUrl);
  for (const style of Array.from(holder.querySelectorAll("style"))) {
    const raw = style.textContent || "";
    if (source === "fetch" && raw.length > FETCH_STYLE_CAP) {
      style.remove();
      continue;
    }
    style.textContent = scopeCss(absolutizeCssUrls(raw, baseUrl));
  }
  return holder.innerHTML;
}

/** Total inlined stylesheet budget for one page. */
export const LINKED_CSS_BUDGET = 400_000;

/**
 * Replace every stylesheet link with the scoped text of the sheet.
 *
 * Sequential, not parallel: this runs on the UI thread and a page with twenty
 * sheets firing at once is a stall the reader feels. Each one that fails or
 * runs past the budget is simply dropped — a page with some of its design is
 * the thing we are trying to get to, so partial success is success.
 */
async function inlineLinkedStyles(holder: HTMLElement, baseUrl: string): Promise<void> {
  const links = Array.from(holder.querySelectorAll("link")).filter((link) => {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    return rel.includes("stylesheet");
  });
  let budget = LINKED_CSS_BUDGET;
  for (const link of links) {
    const href = link.getAttribute("href");
    link.remove();
    if (!href || budget <= 0) continue;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute)) continue;
    let css: string;
    try {
      css = await fetchViaViteProxyText(absolute);
    } catch {
      continue;
    }
    if (css.length > budget) continue;
    budget -= css.length;
    const style = holder.ownerDocument.createElement("style");
    style.textContent = scopeCss(absolutizeCssUrls(css, absolute));
    holder.insertBefore(style, holder.firstChild);
  }
}

/** Anything the page needs, through the same proxy the HTML came from. */
async function fetchViaViteProxyText(url: string): Promise<string> {
  const response = await fetch(`./__lc-web-fetch?url=${encodeURIComponent(url)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
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

async function fetchHtmlCheap(url: string): Promise<{ url: string; html: string }> {
  const invoke = await loadInvoke();
  if (invoke) {
    return invoke<{ url: string; html: string }>("fetch_html", { url });
  }
  return fetchViaViteProxy(url);
}

/**
 * Reader HTML from a GET body, or null if this is not an article.
 *
 * Cheap path: skip the capture webview when the server already shipped the
 * prose (Wikipedia). Dashboards and search pages return null so the caller
 * can still snapshot / capture.
 */
export async function readerPageFromHtml(
  html: string,
  url: string,
  note?: string,
): Promise<FetchedWebPage | null> {
  if (html.length > PAGE_MAX_BYTES) {
    throw new Error("this page is too large to annotate here");
  }
  const { extractArticle, withArticleTitle } = await import("./webReader");
  const article = extractArticle(html, url);
  if (!article) return null;
  const title = article.title || titleFromHtml(html) || url;
  console.debug("[lc-web]", "reader", {
    htmlBytes: html.length,
    articleBytes: article.html.length,
  });
  return {
    url,
    title,
    // Readability hands back the body without its headline — see `withArticleTitle`.
    html: withArticleTitle(article.html, title, url),
    source: "reader",
    note,
  };
}

/**
 * Turn a live view's DOM into the document the pad paints.
 *
 * The same decision `fetchWebPage` makes at the end — article if it is one,
 * whole page if it is not — but from HTML someone already has, so freezing what
 * you were just looking at does not re-fetch it. Whatever you browsed to is
 * what gets frozen.
 */
export async function pageFromCapturedHtml(
  html: string,
  url: string,
  opts?: { mode?: WebRenderMode },
): Promise<FetchedWebPage> {
  const mode: WebRenderMode = opts?.mode ?? DEFAULT_WEB_RENDER_MODE;
  if (mode === "reader") {
    const article = await readerPageFromHtml(html, url);
    if (article) return article;
  }
  return snapshotPage({ url, html }, "capture");
}

async function snapshotPage(
  fetched: { url: string; html: string },
  source: WebHtmlSource,
  note?: string,
): Promise<FetchedWebPage> {
  if (fetched.html.length > PAGE_MAX_BYTES) {
    throw new Error("this page is too large to annotate here");
  }
  const before = styleTagStats(fetched.html);
  const html = await isolateWebCss(
    sanitizeWebHtml(fetched.html, fetched.url, source),
    fetched.url,
    source,
  );
  const after = styleTagStats(html);
  console.debug("[lc-web]", source, {
    htmlBytes: fetched.html.length,
    styleBefore: before,
    styleAfter: after,
  });
  return {
    url: fetched.url,
    title: titleFromHtml(fetched.html) || fetched.url,
    html,
    source,
    note,
  };
}

/**
 * Fetch a page and turn it into a document.
 *
 * `mode` is the reader's standing choice, not a guess about the page — see
 * {@link WebRenderMode}. In `reader` this is the old behaviour: try Readability
 * first and take it if it returns anything. In `page` extraction is skipped
 * entirely, so the whole page arrives with its own structure intact — which is
 * the only thing that works for a feed, where the boundaries between items are
 * the content.
 */
export async function fetchWebPage(
  raw: string,
  opts?: { mode?: WebRenderMode },
): Promise<FetchedWebPage> {
  const mode: WebRenderMode = opts?.mode ?? DEFAULT_WEB_RENDER_MODE;
  const url = normalizeExternalUrl(raw);
  if (!url || !isSafeExternalUrl(url)) {
    throw new Error("that does not look like an http(s) address");
  }

  /*
   * Cheap GET first. Wikipedia (and any server-rendered article) is already
   * in that HTML, so Readability can finish without spinning a hidden
   * webview or waiting SETTLE_MS. Capture stays for JS shells (Google).
   *
   * In `page` mode the cheap copy is still fetched — it is the fallback when
   * the offscreen render is unavailable — but it is not run through
   * Readability, because the whole point is to keep the page.
   */
  let cheap: { url: string; html: string } | null = null;
  let cheapError: string | undefined;
  try {
    cheap = await fetchHtmlCheap(url);
    if (mode === "reader") {
      const article = await readerPageFromHtml(cheap.html, cheap.url);
      if (article) return article;
    }
  } catch (cause) {
    cheapError = cause instanceof Error ? cause.message : String(cause);
  }

  let fetched: { url: string; html: string };
  let source: WebHtmlSource = "fetch";
  let note: string | undefined;

  /*
   * Only where a second web view can actually be placed and torn down.
   *
   * `isTauriRuntime()` alone was not the question, and for a while the answer
   * was "not Android". Wry maps `new_as_child` onto `new` there and its
   * `set_bounds` is a no-op, so the `y: 10_000` that parks the render view
   * offscreen was ignored and the view opened full-screen over the app; the
   * bridge it then needed refused, and the close that would have cleared it
   * was the same unsupported call. Reader mode hid that for a long time by
   * returning from the cheap GET before reaching here; whole-page mode skips
   * the extraction, so every open arrives here.
   *
   * What the guard asks now is which surface answers, not which platform this
   * is: wry on desktop, the `livewebview` plugin's own `WebView` on Android,
   * neither in a plain browser tab. The tablet renders the page rather than
   * the fetched copy of it, which is the difference between a snapshot of a
   * feed and a picture of its markup.
   */
  if (isTauriRuntime() && liveWebviewSupported()) {
    try {
      const { captureRenderedPage } = await import("./webPageCapture");
      const width = webPageWidthForViewport(
        typeof window !== "undefined" ? window.innerWidth : WEB_PAGE_W,
      );
      fetched = await captureRenderedPage(url, {
        width,
        height: Math.max(800, Math.round(width * 0.7)),
      });
      source = "capture";
    } catch (cause) {
      note = cause instanceof Error ? cause.message : String(cause);
      console.warn("[lc-web] capture failed, falling back", cause);
      if (cheap) {
        fetched = cheap;
        source = "fetch";
      } else {
        fetched = await fetchHtmlCheap(url);
      }
      if (!note) note = cheapError;
    }
  } else if (cheap) {
    fetched = cheap;
  } else {
    fetched = await fetchHtmlCheap(url);
  }

  if (mode === "reader") {
    const capturedArticle = await readerPageFromHtml(fetched.html, fetched.url, note);
    if (capturedArticle) return capturedArticle;
  }
  return snapshotPage(fetched, source, note);
}
