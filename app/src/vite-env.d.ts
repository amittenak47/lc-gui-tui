/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEATURE_LEETCODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Vite's `?worker` suffix imports, which TypeScript doesn't know about on its
 * own. Monaco needs one for its editor worker; without it the editor falls back
 * to running language services on the main thread and janks the stylus.
 */
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

interface Window {
  MonacoEnvironment?: {
    getWorker?: (workerId: string, label: string) => Worker;
    getWorkerUrl?: (workerId: string, label: string) => string;
  };
}

/**
 * pdf.js's worker imported as a *module*, not through Vite's `?worker`.
 *
 * The suffixed import above is the normal path — it spawns a real Worker. This
 * one pulls the same code into whichever realm imports it, which is how
 * `openPdfDocument` parses on the main thread when the worker cannot. The
 * package ships no types for the worker entry point, only for `pdf.mjs`.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
