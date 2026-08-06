/**
 * Problem statement as HTML under the ink — same camera-synced paper as md-ink.
 *
 * Excalidraw text was a bad fit for a long LeetCode write-up: soft-wrap fought
 * autoResize, height estimates were wrong (scroll felt like two stops), and we
 * already had a markdown document layer that scrolls continuously with the board.
 */

import { useEffect, useMemo, useRef } from "react";
import { normalizeStatementForMarkdown } from "../util/statementMarkdown";
import { renderMarkdown } from "./MdInkDocument";

export interface StatementDocumentProps {
  title: string;
  difficulty?: string | null;
  tags?: string[];
  caseCount?: number;
  description?: string | null;
  /** Measured height in scene units (1 CSS px ≈ 1 scene unit at column width). */
  onMeasure?: (height: number) => void;
}

function metaParts(
  difficulty?: string | null,
  tags?: string[],
  caseCount?: number,
): string[] {
  return [
    difficulty?.trim() || null,
    ...(tags ?? []).slice(0, 5).map((tag) => tag.trim()).filter(Boolean),
    typeof caseCount === "number" && caseCount > 0 ? `${caseCount} sample cases` : null,
  ].filter((part): part is string => Boolean(part && part.length > 0));
}

export function StatementDocument({
  title,
  difficulty,
  tags,
  caseCount,
  description,
  onMeasure,
}: StatementDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const chips = useMemo(
    () => metaParts(difficulty, tags, caseCount),
    [caseCount, difficulty, tags],
  );
  const bodyHtml = useMemo(
    () =>
      renderMarkdown(
        normalizeStatementForMarkdown(description?.trim() || "_No description in the corpus._"),
      ),
    [description],
  );
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const report = () => {
      const height = node.scrollHeight;
      if (height > 0) onMeasureRef.current?.(height);
    };
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [bodyHtml, chips, title]);

  return (
    <div ref={nodeRef} className="lc-md-ink-doc lc-statement-doc lc-md-ink-carbon">
      <h1 className="lc-statement-title">{title}</h1>
      {chips.length > 0 && (
        <div className="lc-statement-tags" aria-label="Problem tags">
          {chips.map((chip) => (
            <span key={chip} className="lc-statement-tag">
              {chip}
            </span>
          ))}
        </div>
      )}
      <div
        className="lc-statement-body"
        // Body is corpus markdown — sanitised in renderMarkdown.
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </div>
  );
}
