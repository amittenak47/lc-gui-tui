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
