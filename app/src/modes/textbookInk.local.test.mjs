/**
 * Drive the ink pipeline against the writer's actual textbooks.
 *
 * These files stay in Downloads — they are not fixtures and must not be
 * copied into the repo. If a file is missing the case is skipped, so CI
 * without those PDFs still passes.
 *
 * `.mjs` because this reads the disk (see vite.config.ts on node:fs).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { InkPageBook } from "../canvas/inkPageCache";
import {
  DENSE_PAGE_POINTS,
  encodeInkOps,
  inkStorageStats,
  scaleInkStorage,
} from "../canvas/inkCodec";
import { INK_LRU_RADIUS, lruWindow, pageIdForOp } from "../canvas/inkPageIndex";
import { NO_PRESSURE } from "../canvas/rasterInk";
import { pdfStackHeight, windowedPages } from "./PdfDocument";

const DOWNLOADS = join(homedir(), "Downloads");
const PAGE_GAP = 18;
const FRAME_WIDTH = 700;

const TEXTBOOKS = [
  {
    id: "kleinberg",
    name: "Kleinberg, Jon - Algorithm design _ monograph (2005, Tsinghua University Press) - libgen.li.pdf",
  },
  {
    id: "dasgupta",
    name: "Sanjoy Dasgupta, Christos H. Papadimitriou, Umesh Vazirani - Algorithms (2011, McGraw-Hill) - libgen.li.pdf",
  },
];

function strokeAt(y, extra = {}) {
  return {
    kind: "draw",
    color: "#111111",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 40, y, pressure: NO_PRESSURE },
      { x: 80, y, pressure: NO_PRESSURE },
    ],
    ...extra,
  };
}

describe("textbook PDFs from Downloads", () => {
  let pdfjs;

  beforeAll(async () => {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  });

  for (const book of TEXTBOOKS) {
    const path = join(DOWNLOADS, book.name);
    const present = existsSync(path);

    describe.skipIf(!present)(book.id, () => {
      it(
        "opens, lays out every page, and keeps decoded ink to an LRU window",
        async () => {
          const bytes = new Uint8Array(readFileSync(path));
          const fileBytes = statSync(path).size;
          const doc = await pdfjs.getDocument({ data: bytes }).promise;
          const numPages = doc.numPages;
          expect(numPages).toBeGreaterThan(50);

          const laid = [];
          for (let n = 1; n <= numPages; n += 1) {
            const page = await doc.getPage(n);
            const natural = page.getViewport({ scale: 1 });
            const fit = FRAME_WIDTH / natural.width;
            const viewport = page.getViewport({ scale: fit });
            laid.push({
              pageId: n,
              width: viewport.width,
              height: viewport.height,
            });
            page.cleanup();
          }
          if (typeof doc.destroy === "function") await doc.destroy();
          else if (typeof doc.cleanup === "function") await doc.cleanup();

          const stack = pdfStackHeight(
            laid.map((page) => ({ height: page.height })),
            PAGE_GAP,
          );
          expect(stack).toBeGreaterThan(laid[0].height);
          expect(windowedPages([50], numPages)).toHaveLength(3);
          expect(windowedPages([50], numPages)).toEqual([49, 50, 51]);

          const frames = [];
          let y = 0;
          for (const page of laid) {
            frames.push({ pageId: page.pageId, minY: y, maxY: y + page.height });
            y += page.height + PAGE_GAP;
          }

          const ink = new InkPageBook();
          ink.setFrames(frames);
          ink.setVisiblePage(1);

          const firstY = (frames[0].minY + frames[0].maxY) / 2;
          const midPage = Math.min(50, numPages);
          const midY = (frames[midPage - 1].minY + frames[midPage - 1].maxY) / 2;
          const lastY = (frames[numPages - 1].minY + frames[numPages - 1].maxY) / 2;
          const seamY0 = frames[0].maxY - 2;
          const seamY1 = frames[1].minY + 2;

          ink.commit(strokeAt(firstY));
          ink.setVisiblePage(midPage);
          const mid = ink.commit(strokeAt(midY));
          ink.setVisiblePage(numPages);
          ink.commit(strokeAt(lastY));
          ink.commit(
            strokeAt(seamY0, {
              points: [
                { x: 40, y: seamY0, pressure: NO_PRESSURE },
                { x: 40, y: seamY1, pressure: NO_PRESSURE },
              ],
            }),
          );

          expect(pageIdForOp(mid, frames)).toBe(midPage);
          expect(ink.opCount()).toBe(4);
          expect(ink.undoOnce()).toBe(true);
          expect(ink.opCount()).toBe(3);
          expect(ink.redoOnce()).toBe(true);

          ink.setVisiblePage(midPage);
          const hotPages = [...ink.hot.keys()]
            .filter((id) => id !== 0)
            .sort((a, b) => a - b);
          const window = lruWindow(midPage, numPages).filter((id) => id !== 0);
          expect(hotPages).toContain(midPage);
          expect(hotPages.every((id) => window.includes(id))).toBe(true);
          expect(hotPages).not.toContain(1);
          expect(hotPages).not.toContain(numPages);
          expect(hotPages.length).toBeLessThanOrEqual(INK_LRU_RADIUS * 2 + 1);
          expect(ink.paintOps().length).toBeLessThan(ink.opCount());
          expect(ink.assembleOps()).toHaveLength(4);

          const encoded = ink.assembleEncoded();
          const live = inkStorageStats(encoded, ink.assembleOps());
          const dense = inkStorageStats(
            encodeInkOps([
              strokeAt(firstY, {
                points: Array.from({ length: DENSE_PAGE_POINTS }, (_, i) => ({
                  x: 40 + (i % 20),
                  y: firstY + i * 0.4,
                  pressure: NO_PRESSURE,
                })),
              }),
            ]),
          );
          const full = scaleInkStorage(dense, numPages, 4);

          console.info(`textbook-${book.id}`, {
            fileMB: +(fileBytes / 1024 / 1024).toFixed(1),
            pages: numPages,
            stackPx: Math.round(stack),
            paintWindow: windowedPages([midPage], numPages),
            lruHot: hotPages,
            strokes: ink.opCount(),
            encodedStrokeBytes: live.encodedPayloadBytes,
            ifEveryPageDenseMB: +(full.encodedPayloadBytes / 1024 / 1024).toFixed(2),
            liveRamIfDenseMB: +(full.livePointRamBytes / 1024 / 1024).toFixed(1),
            snapshotsIfDenseMB: +(full.encodedWithSnapshotsBytes / 1024 / 1024).toFixed(2),
          });
        },
        180_000,
      );
    });
  }
});
