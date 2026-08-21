/**
 * Freeze a live document into HTML the pad can paint.
 *
 * Runs in two places: jsdom tests, and `eval` inside a hidden capture webview
 * after the page's own JS has assembled the DOM. No module imports inside
 * {@link serializeCurrentDocument} — `Function#toString` is the eval payload.
 */

export interface SerializedPage {
  url: string;
  html: string;
}

export async function serializeCurrentDocument(): Promise<SerializedPage> {
  const doc = document;
  const base = location.href;

  function absolutizeCssUrls(css: string, href: string): string {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
      const url = String(raw).trim();
      if (!url || /^(data:|https?:|blob:|#)/i.test(url)) return match;
      try {
        return `url(${quote}${new URL(url, href).href}${quote})`;
      } catch {
        return match;
      }
    });
  }

  function cssTextFromSheet(sheet: CSSStyleSheet): string | null {
    try {
      const rules = sheet.cssRules;
      const parts: string[] = [];
      for (let i = 0; i < rules.length; i += 1) {
        parts.push(rules[i].cssText);
      }
      return absolutizeCssUrls(parts.join("\n"), sheet.href || base);
    } catch {
      return null;
    }
  }

  /**
   * CSS that lives in a constructable stylesheet, not in a `<style>`.
   *
   * `document.styleSheets` does not include `adoptedStyleSheets` — they are a
   * separate list — so a framework that builds its CSS at runtime, which is
   * most of them now, had all of it dropped here without a word.
   */
  function adoptedCss(root: Document | ShadowRoot): string {
    const adopted = (root as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
    if (!adopted || adopted.length === 0) return "";
    const parts: string[] = [];
    for (const sheet of Array.from(adopted)) {
      const text = cssTextFromSheet(sheet);
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }

  function addStyle(css: string): void {
    if (!css.trim()) return;
    const style = doc.createElement("style");
    style.textContent = css;
    doc.head.appendChild(style);
  }

  /**
   * Lift open shadow roots into the light DOM, deepest first.
   *
   * The serialised payload is `documentElement.outerHTML`, and `outerHTML` does
   * not descend into a shadow root — so every custom element came out as an
   * empty tag. Not mangled: absent. That is most of why a page built from web
   * components arrived looking gutted.
   *
   * Flattening throws away encapsulation, which sounds worse than it is: the
   * snapshot is a read-only document, and `scopeCss` downstream rewrites every
   * selector anyway, so there is no encapsulation left to protect by the time
   * anyone paints this. A closed root stays invisible — page script cannot
   * reach one, and forcing them open needs an init script the JS webview API
   * does not expose.
   */
  function flattenShadowRoots(root: ParentNode): void {
    const hosts: Element[] = [];
    for (const node of Array.from(root.querySelectorAll("*"))) {
      if ((node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) hosts.push(node);
    }
    for (const host of hosts) {
      const shadow = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!shadow) continue;
      // Depth first: a root inside a root has to be lifted before its parent is.
      flattenShadowRoots(shadow);
      addStyle(adoptedCss(shadow));
      const moved = doc.createDocumentFragment();
      for (const child of Array.from(shadow.childNodes)) {
        // A `<slot>` renders its assigned light-DOM children; the host already
        // holds those, so the slot itself is scaffolding and goes.
        if (child instanceof Element && child.tagName === "SLOT") {
          for (const slotted of Array.from(child.childNodes)) moved.appendChild(slotted);
          continue;
        }
        moved.appendChild(child);
      }
      host.insertBefore(moved, host.firstChild);
    }
  }

  /*
   * Decide invisibility here, where the computed styles are (§4a).
   *
   * The rewrite downstream has only the markup, so it was reduced to guessing
   * from attributes — and `aria-hidden="true"` is what pages put on things that
   * are decorative but perfectly *visible*, icons above all. That is why the
   * sidebar came back without its glyphs. Only a computed style can tell a
   * hidden element from an unlabelled one, and only this pass has them.
   *
   * The same walk records where anything pinned actually sits. A `fixed`
   * element is painted against the viewport, so dropping it into the flow puts
   * it wherever its tag happens to be in the markup — usually a banner across
   * the middle of the article. Its document offset is knowable now and
   * unknowable later.
   */
  const HIDDEN_ATTR = "data-lc-hidden";
  const PIN_TOP = "data-lc-pin-top";
  const PIN_LEFT = "data-lc-pin-left";
  const all = Array.from(doc.body ? doc.body.querySelectorAll("*") : []);
  const scrollY = window.scrollY || doc.documentElement.scrollTop || 0;
  const scrollX = window.scrollX || doc.documentElement.scrollLeft || 0;
  for (const node of all) {
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) continue;
    let style: CSSStyleDeclaration;
    try {
      style = window.getComputedStyle(node);
    } catch {
      continue;
    }
    const box = node.getBoundingClientRect();
    /*
     * Zero-sized only counts when there is nothing inside.
     *
     * A wrapper can measure zero and still be the only thing holding its
     * children — `display: contents`, a float-only container, a box whose
     * children are all absolutely positioned. Pruning it takes the content with
     * it, which is a far worse failure than leaving an empty spacer in. So the
     * size test applies to leaves, where it does what it was meant to do: drop
     * tracking pixels and collapsed spacers.
     */
    const empty =
      node.children.length === 0 && !(node.textContent || "").trim();
    /*
     * Parsed, not coerced. `Number("")` is 0, so an engine that reports an
     * unset opacity as the empty string would have called every element on the
     * page invisible and returned a blank capture.
     */
    const opacity = Number.parseFloat(style.opacity);
    const invisible =
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (Number.isFinite(opacity) && opacity === 0) ||
      (empty && box.width === 0 && box.height === 0);
    if (invisible) {
      node.setAttribute(HIDDEN_ATTR, "1");
      continue;
    }
    if (style.position === "fixed") {
      node.setAttribute(PIN_TOP, String(Math.round(box.top + scrollY)));
      node.setAttribute(PIN_LEFT, String(Math.round(box.left + scrollX)));
    }
  }

  const drop = doc.querySelectorAll(
    "script, iframe, object, embed, link[rel=preload], link[rel=modulepreload], link[rel=prefetch]",
  );
  for (const node of Array.from(drop)) node.remove();

  flattenShadowRoots(doc);
  addStyle(adoptedCss(doc));

  const sheets = Array.from(doc.styleSheets);
  for (const sheet of sheets) {
    const owner = sheet.ownerNode;
    if (!(owner instanceof Element)) continue;
    const href =
      sheet.href ||
      (owner.getAttribute("href") ? new URL(owner.getAttribute("href") || "", base).href : "");
    let css = cssTextFromSheet(sheet);
    if ((css == null || !css.trim()) && href) {
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error("css");
        css = absolutizeCssUrls(await response.text(), href);
      } catch {
        if (owner.tagName === "LINK") {
          owner.setAttribute("href", href);
        }
        continue;
      }
    }
    if (!css) continue;
    const style = doc.createElement("style");
    style.textContent = css;
    owner.replaceWith(style);
  }

  const leftoverLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
  for (const link of leftoverLinks) {
    const hrefAttr = link.getAttribute("href");
    if (!hrefAttr) continue;
    let href = hrefAttr;
    try {
      href = new URL(hrefAttr, base).href;
    } catch {
      continue;
    }
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("css");
      const style = doc.createElement("style");
      style.textContent = absolutizeCssUrls(await response.text(), href);
      link.replaceWith(style);
    } catch {
      link.setAttribute("href", href);
    }
  }

  const imgs = Array.from(doc.querySelectorAll("img[src]"));
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.indexOf("data:") === 0) continue;
    let abs = src;
    try {
      abs = new URL(src, base).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) {
      img.setAttribute("src", abs);
      continue;
    }
    try {
      const response = await fetch(abs);
      if (!response.ok) throw new Error("img");
      const blob = await response.blob();
      const data = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          resolve(String(reader.result));
        };
        reader.onerror = function () {
          reject(reader.error);
        };
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", String(data));
      /*
       * The data URL is the only copy that will still resolve, so it has to be
       * the only candidate.
       *
       * `srcset` outranks `src` whenever it is present, and its entries still
       * pointed at the CDN — so the frozen page went back to the network for an
       * image it was already carrying, and got a broken glyph when that failed.
       * `<picture>` is the same trick one level up: its `<source>` wins before
       * the `<img>` is even consulted.
       */
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      const picture = img.parentElement;
      if (picture && picture.tagName === "PICTURE") {
        for (const source of Array.from(picture.querySelectorAll("source"))) {
          source.remove();
        }
      }
    } catch {
      img.setAttribute("src", abs);
    }
  }

  const refs = Array.from(doc.querySelectorAll("[href], [src]"));
  for (const node of refs) {
    const attr = node.hasAttribute("href") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw || /^(https?:|data:|mailto:|#|javascript:)/i.test(raw)) continue;
    try {
      node.setAttribute(attr, new URL(raw, base).href);
    } catch {
      /* leave */
    }
  }

  return { url: base, html: doc.documentElement.outerHTML };
}

/** Start serialize in the capture webview; poll {@link SERIALIZE_POLL_SCRIPT}. */
export const SERIALIZE_PAGE_SCRIPT = `(function(){if(window.__lcCaptureKick)return true;window.__lcCaptureKick=true;window.__lcCapture={done:false};(${serializeCurrentDocument.toString()})().then(function(result){window.__lcCapture={done:true,result:result};},function(err){window.__lcCapture={done:true,error:String(err)};});return true;})()`;

export const SERIALIZE_POLL_SCRIPT =
  "(function(){var c=window.__lcCapture;if(!c||!c.done)return null;return c;})()";

export const READY_STATE_SCRIPT = "document.readyState";
