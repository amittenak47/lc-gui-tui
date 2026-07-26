/// <reference types="vite/client" />

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
