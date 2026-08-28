/**
 * Viewport page index for a stacked PDF.
 *
 * The pages live in scene space and ride the board camera, so a thumbnail
 * strip in the document would scale and pan with the book. This rail is chrome:
 * an iOS-style filmstrip under the header. Click jumps the camera; only
 * neighbouring thumbs copy a live canvas. Viewed pages keep a JPEG in the
 * session hash map (and on disk after the first capture). Missing pages fill
 * only while the camera is idle with the strip open — not from the paint pump.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  PDF_FILM_THUMB_CSS,
  PDF_LETTER_ASPECT,
  filmStripWheelDelta,
  grabLivePdfThumb,
  grabLruPdfThumb,
  peekPdfThumb,
  peekPdfThumbs,
  publishPdfFilmThumbWanted,
  rememberPdfThumb,
  subscribePdfFilmCurrent,
  subscribePdfFilmPredicted,
  subscribePdfThumbs,
  thumbWindow,
  type PdfThumbRenderer,
} from "./pdfFilm";

export type { PdfThumbRenderer };

export interface PdfPageRailProps {
  /**
   * Which mounted workspace this is, for PDF navigation state.
   *
   * Page camera, reading frames and the visible-page sets live in a module
   * beside the filmstrip and used to be one set of globals. Two documents can
   * be mounted at once — a split, or one parked in the mount budget — so they
   * are keyed, and the tab is the key: the same file opened with two annotation
   * sets shares a content hash and shares nothing about where you are in it.
   */
  filmScope: string;
  count: number;
  current: number;
  /** Content hash of the open PDF — session thumbs survive closing the strip. */
  docHash?: string | null;
  /** width / height per page, 1-indexed via array slot `page - 1`. */
  aspects?: number[];
  onJump: (page: number) => void;
  renderThumb?: PdfThumbRenderer;
}

export function PdfPageRail({
  filmScope,
  count,
  current,
  docHash = null,
  aspects,
  onJump,
  renderThumb,
}: PdfPageRailProps) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef<Set<number>>(new Set());
  const [stripTick, setStripTick] = useState(0);
  const [thumbs, setThumbs] = useState<Map<number, string>>(() => peekPdfThumbs(docHash));
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  const inflightRef = useRef<Set<number>>(new Set());
  const renderThumbRef = useRef(renderThumb);
  renderThumbRef.current = renderThumb;
  const docHashRef = useRef(docHash);
  docHashRef.current = docHash;
  const [railCurrent, setRailCurrent] = useState(current);
  const [railPredicted, setRailPredicted] = useState(0);
  const currentPage = railCurrent;

  useEffect(() => subscribePdfFilmCurrent(filmScope, setRailCurrent), []);
  useEffect(() => subscribePdfFilmPredicted(filmScope, setRailPredicted), []);
  useEffect(() => {
    return subscribePdfThumbs(() => {
      setThumbs(peekPdfThumbs(docHashRef.current));
    });
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || count < 2) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const dx = filmStripWheelDelta(event.deltaX, event.deltaY);
      if (dx === 0) return;
      event.preventDefault();
      strip.scrollLeft += dx;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [count]);

  useEffect(() => {
    const node = currentRef.current;
    if (!node) return;
    node.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "auto",
    });
  }, [currentPage]);

  useEffect(() => {
    setThumbs(peekPdfThumbs(docHash));
    inflightRef.current.clear();
    visibleRef.current.clear();
  }, [count, docHash]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || count < 2) return;
    if (typeof IntersectionObserver !== "function") {
      visibleRef.current = new Set(
        Array.from({ length: Math.min(count, 24) }, (_, i) => i + 1),
      );
      setStripTick((tick) => tick + 1);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.pdfFilmPage);
          if (!Number.isFinite(n)) continue;
          if (entry.isIntersecting) {
            if (!visibleRef.current.has(n)) {
              visibleRef.current.add(n);
              changed = true;
            }
          } else if (visibleRef.current.delete(n)) {
            changed = true;
          }
        }
        if (changed) setStripTick((tick) => tick + 1);
      },
      { root: strip, rootMargin: "120px", threshold: 0.01 },
    );
    for (const node of strip.querySelectorAll("[data-pdf-film-page]")) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [count]);

  useEffect(() => {
    if (count < 2) return;
    let cancelled = false;
    const needed = thumbWindow(currentPage, count, visibleRef.current);
    publishPdfFilmThumbWanted(filmScope, needed);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(PDF_FILM_THUMB_CSS * dpr);

    const fill = async () => {
      const hash = docHashRef.current ?? "";
      const keep = (page: number, url: string) => {
        rememberPdfThumb(hash, page, url);
        setThumbs((prev) => {
          if (prev.get(page) === url) return prev;
          const next = new Map(prev);
          next.set(page, url);
          return next;
        });
      };
      for (const page of needed) {
        if (cancelled) return;
        const isFocus = page === currentPage;
        if (!isFocus && (thumbsRef.current.has(page) || inflightRef.current.has(page))) {
          continue;
        }
        if (isFocus && inflightRef.current.has(page)) continue;
        const live =
          grabLivePdfThumb(
            page,
            px,
            stripRef.current?.closest(".lc-canvas-wrap"),
          ) ?? grabLruPdfThumb(page, px);
        if (live) {
          keep(page, live);
          continue;
        }
        const cached = peekPdfThumb(hash, page);
        if (cached && !isFocus) {
          keep(page, cached);
          continue;
        }
        if (thumbsRef.current.has(page) || inflightRef.current.has(page)) continue;
        const render = renderThumbRef.current;
        if (!render) continue;
        inflightRef.current.add(page);
        const url = await render(page);
        inflightRef.current.delete(page);
        if (cancelled || !url) continue;
        keep(page, url);
      }
    };
    void fill();
    return () => {
      cancelled = true;
    };
  }, [count, currentPage, stripTick, renderThumb]);

  if (count < 2) return null;

  const pages = Array.from({ length: count }, (_, i) => i + 1);

  return (
    <nav ref={stripRef} className="lc-pdf-rail" aria-label="PDF pages">
      {pages.map((page) => {
        const active = page === currentPage;
        const predicted = page === railPredicted && railPredicted > 0 && !active;
        const aspect = aspects?.[page - 1] || PDF_LETTER_ASPECT;
        const src = thumbs.get(page) ?? peekPdfThumb(docHash, page);
        return (
          <button
            key={page}
            ref={active ? currentRef : undefined}
            type="button"
            className={
              predicted ? "lc-pdf-rail-page is-predicted" : "lc-pdf-rail-page"
            }
            data-pdf-film-page={page}
            style={{ "--lc-pdf-aspect": String(aspect) } as CSSProperties}
            aria-current={active ? "page" : undefined}
            aria-label={`Page ${page}`}
            onClick={() => onJump(page)}
          >
            <span className="lc-pdf-rail-thumb">
              {src ? <img src={src} alt="" draggable={false} /> : null}
            </span>
            <span className="lc-pdf-rail-num">{page}</span>
          </button>
        );
      })}
    </nav>
  );
}
