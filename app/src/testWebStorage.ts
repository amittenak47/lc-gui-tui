/**
 * Vitest setup: give jsdom tests their Web Storage back on Node 25+.
 *
 * Node 25 added a global `localStorage`/`sessionStorage` that is `undefined`
 * unless the process is started with `--localstorage-file`. Vitest's jsdom
 * environment does not overwrite globals Node already defines, so every
 * jsdom test saw `localStorage` as undefined. Older Node versions have no such
 * global, so this is a no-op there, and node-environment tests are untouched.
 */
type JsdomGlobal = { jsdom?: { window?: Record<string, unknown> } };

const dom = (globalThis as JsdomGlobal).jsdom?.window;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    if ((globalThis as Record<string, unknown>)[key] == null && dom[key]) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: dom[key],
      });
    }
  }
}
