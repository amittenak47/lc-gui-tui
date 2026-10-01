/**
 * `@tauri-apps/api/core`, with `invoke` visible to the debug log.
 *
 * Tauri defines `window.__TAURI_INTERNALS__.invoke` read-only, so native calls
 * cannot be watched from inside the page. Every module here imports `invoke`
 * from `@tauri-apps/api/core`, and vite.config.ts points that one specifier at
 * this file: the rest of the module is the real one, and `invoke` records the
 * call when the log is on. Off, it is one boolean check and the real call.
 */
import { invoke as realInvoke, type InvokeArgs, type InvokeOptions } from "../../node_modules/@tauri-apps/api/core.js";
import { brief, debugLog, debugLogActive } from "./debugLog";

export * from "../../node_modules/@tauri-apps/api/core.js";

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (!debugLogActive()) return realInvoke<T>(cmd, args, options);
  const started = performance.now();
  return realInvoke<T>(cmd, args, options).then(
    (result) => {
      debugLog({ k: "invoke", n: cmd, a: brief(args), r: brief(result), ms: Math.round(performance.now() - started) });
      return result;
    },
    (cause: unknown) => {
      debugLog({ k: "invoke", n: cmd, a: brief(args), e: brief(cause), ms: Math.round(performance.now() - started) });
      throw cause;
    },
  );
}
