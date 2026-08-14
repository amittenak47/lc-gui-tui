/**
 * Viewport page index for a stacked PDF.
 *
 * The pages live in scene space and ride the board camera, so a thumbnail
 * strip in the document would scale and pan with the book. This rail is chrome:
 * a fixed column of page numbers. Click jumps the camera; the paint window
 * still only holds neighbouring bitmaps.
 */
import { useEffect, useRef } from "react";

export interface PdfPageRailProps {
  count: number;
  current: number;
  onJump: (page: number) => void;
}

export function PdfPageRail({ count, current, onJump }: PdfPageRailProps) {
  const currentRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (count < 2) return null;

  const pages = Array.from({ length: count }, (_, i) => i + 1);

  return (
    <nav className="lc-pdf-rail" aria-label="PDF pages">
      {pages.map((page) => {
        const active = page === current;
        return (
          <button
            key={page}
            ref={active ? currentRef : undefined}
            type="button"
            className="lc-pdf-rail-page"
            aria-current={active ? "page" : undefined}
            aria-label={`Page ${page}`}
            onClick={() => onJump(page)}
          >
            {page}
          </button>
        );
      })}
    </nav>
  );
}
