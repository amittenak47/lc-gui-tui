/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfDocument } from "./PdfDocument";
import { notePageTurn } from "../util/pageTurnBusy";
import { publishPdfPreloadPages } from "./pdfFilm";

const pdf = vi.hoisted(() => ({
  jobs: [] as { page: number; scale: number; cancel: ReturnType<typeof vi.fn>; onContinue?: (resume: () => void) => void }[],
  text: vi.fn(async () => ({ items: [], styles: {} })),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?worker", () => ({ default: class {} }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  PDFWorker: { create: () => ({}) },
  TextLayer: class { textDivs = []; render = async () => {}; },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async (pageNumber: number) => ({
        pageNumber,
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale, scale }),
        getTextContent: pdf.text,
        render: ({ viewport }: { viewport: { scale: number } }) => {
          let reject!: (cause: Error) => void;
          const promise = viewport.scale > 0.5
            ? new Promise<void>((_, no) => { reject = no; })
            : Promise.resolve();
          const job = { page: pageNumber, scale: viewport.scale, promise,
            cancel: vi.fn(() => reject?.(new Error("Rendering cancelled"))), onContinue: undefined };
          pdf.jobs.push(job);
          return job;
        },
      }),
    }),
    destroy: async () => { for (const job of pdf.jobs) job.cancel(); },
  }),
}));

let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  pdf.jobs.length = 0;
  pdf.text.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("interrupts sharp PDF work, supplies previews during turns, then resumes sharp work at rest", async () => {
  const error = vi.fn();
  await act(async () => root.render(<PdfDocument filmScope="turn-pump" bytes={new ArrayBuffer(1)}
    frameWidth={400} initialPage={2} onError={error} />));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  const sharp = pdf.jobs.find(job => job.scale > 0.5)!;
  expect(sharp).toBeDefined();
  const textBefore = pdf.text.mock.calls.length;
  const resume = vi.fn();
  act(() => {
    sharp.onContinue!(resume);
    notePageTurn("turn-pump");
    publishPdfPreloadPages("turn-pump", [3]);
  });
  expect(sharp.cancel).toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(resume).not.toHaveBeenCalled();
  expect(pdf.jobs.some(job => job.page === 3 && job.scale <= 0.5)).toBe(true);
  expect(host.querySelector('[data-pdf-page="3"][data-painted]')).not.toBeNull();
  expect(pdf.jobs.filter(job => job.scale > 0.5)).toHaveLength(1);
  expect(pdf.text).toHaveBeenCalledTimes(textBefore);
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(pdf.jobs.filter(job => job.scale > 0.5)).toHaveLength(2);
  expect(error).not.toHaveBeenCalled();
});
