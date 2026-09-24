import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAgentProse } from "./agentProse";
import { renderMarkdown } from "./AnnotateDocument";

/** Presentation only: the complete response stays in the transcript and sync. */
export function useWordReveal(text: string, animate = true, animateInitial = false): string {
  const [shown, setShown] = useState(animateInitial ? "" : text);
  const shownRef = useRef(shown);
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduced || document.hidden) {
      shownRef.current = text;
      setShown(text);
      return;
    }
    let length = text.startsWith(shownRef.current) ? shownRef.current.length : 0;
    if (length === text.length) return;
    // Word boundaries preserve original whitespace, code, and math delimiters.
    const ends = [...text.matchAll(/\S+\s*/gu)].map((match) => match.index! + match[0].length);
    let index = ends.findIndex((end) => end > length);
    const batch = Math.max(1, Math.ceil((ends.length - index) / 160));
    const tick = () => {
      index = Math.min(ends.length, index + batch);
      length = index >= ends.length ? text.length : ends[index - 1]!;
      shownRef.current = text.slice(0, length);
      setShown(shownRef.current);
      if (length === text.length) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [text, animate]);
  return text.startsWith(shown) ? shown : "";
}

export const AgentRichText = memo(function AgentRichText({
  text, animate = false, animateInitial = false, className = "",
}: { text: string; animate?: boolean; animateInitial?: boolean; className?: string }) {
  const prepared = useMemo(() => formatAgentProse(text), [text]);
  const html = useMemo(() => renderMarkdown(prepared), [prepared]);
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef(animateInitial ? "" : html);
  useLayoutEffect(() => {
    const node = host.current;
    const changed = previous.current !== html;
    previous.current = html;
    if (!node || !animate || !changed || document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // Parse the complete Markdown once. Revealing partial Markdown repeatedly
    // opens/closes lists, math and code blocks, making the bubble shrink/grow.
    // Opacity animation leaves line wrapping and scroll height unchanged.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) if (walker.currentNode.textContent?.trim() &&
      !(walker.currentNode.parentElement?.closest(".katex, svg, pre, code"))) nodes.push(walker.currentNode as Text);
    let word = 0;
    for (const textNode of nodes) {
      const fragment = document.createDocumentFragment();
      for (const token of (textNode.textContent ?? "").match(/\S+|\s+/gu) ?? []) {
        if (!token.trim()) fragment.append(document.createTextNode(token));
        else {
          const span = document.createElement("span"); span.textContent = token;
          span.className = "lc-agent-word-reveal";
          span.style.animationDelay = `${Math.min(word++ * 12, 1600)}ms`;
          fragment.append(span);
        }
      }
      textNode.replaceWith(fragment);
    }
  }, [html, animate]);
  return <div ref={host} className={`lc-agent-markdown ${className}`}
    // renderMarkdown shares the document renderer's Markdown/KaTeX sanitization.
    dangerouslySetInnerHTML={{ __html: html }} />;
});
