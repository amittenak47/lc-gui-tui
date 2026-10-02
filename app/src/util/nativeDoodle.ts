/**
 * The loading doodle's pen, straight from Android to a worker.
 *
 * While the app starts, the page's thread is busy for half a second at a time
 * laying out a document, and a pen drawn by that thread stops for as long.
 * Here Android takes the touches that start on a doodle and posts their
 * samples down a message channel whose far end is a worker, and the worker
 * draws them — with the doodle's own engine and the app's ink renderer — onto
 * a canvas handed to it. The page's thread is not on the way at any point.
 *
 * Connected once. The channel's port arrives as a window message, which the
 * page hands to the worker; from then on the page only says which doodles
 * are showing and where.
 */

import { isAndroidDevice } from "./androidDevice";

const PORT_MESSAGE = "lc-doodle-port";
const CONNECT_TIMEOUT_MS = 4000;

let host: Promise<Worker | null> | null = null;

/** The worker drawing native doodles, or null where there is no native pen path. */
export function nativeDoodleHost(): Promise<Worker | null> {
  if (host) return host;
  host = connect().catch(() => null);
  return host;
}

async function connect(): Promise<Worker | null> {
  if (typeof window === "undefined" || !isAndroidDevice()) return null;
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return null;
  if (!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return null;
  const worker = new Worker(new URL("../components/loadingDoodle.worker.ts", import.meta.url), { type: "module" });
  const port = new Promise<MessagePort | null>((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, CONNECT_TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      if (event.data !== PORT_MESSAGE || !event.ports[0]) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(event.ports[0]);
    }
    window.addEventListener("message", onMessage);
  });
  const { invoke } = await import("@tauri-apps/api/core");
  const ok = await invoke<boolean>("connect_native_doodle").catch(() => false);
  const native = ok ? await port : null;
  if (!native) {
    worker.terminate();
    return null;
  }
  worker.postMessage({ type: "port", port: native }, [native]);
  return worker;
}
