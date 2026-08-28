import { createReadStream, cpSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * pdf.js's data directories, served in dev and copied into the build.
 *
 * `standard_fonts` holds metrics for the base-14 fonts a PDF is allowed to
 * assume the reader has, `cmaps` maps CJK encodings, and `wasm` holds the
 * JBIG2 / JPEG2000 image decoders (JS fallback in this pdfjs-dist build).
 * None of these are importable code — pdf.js fetches them by URL at render
 * time. Missing fonts skew glyph widths; missing cmaps blank CJK text;
 * missing `wasmUrl` blanks a scanned textbook (JBIG2 per page) while layout
 * still reports a full stack of white sheets.
 *
 * Copied rather than added to `public/`: they belong to a dependency, and a
 * checked-in copy would drift the moment pdfjs-dist is bumped.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["standard_fonts", "cmaps", "wasm"] as const;
  return {
    name: "lc-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const dir = dirs.find((name) => url.startsWith(`/${name}/`));
        if (!dir) return next();
        const file = join(root, decodeURIComponent(url.slice(1)));
        // The prefix check is the guard against `/cmaps/../../…` walking out
        // of the package and serving the developer's disk over the dev server.
        if (!file.startsWith(join(root, dir)) || !existsSync(file)) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of dirs) {
        const from = join(root, dir);
        if (existsSync(from)) cpSync(from, join("dist", dir), { recursive: true });
      }
    },
  };
}

const PAGE_MAX_BYTES = 8_000_000;
const WEB_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Browser-preview path for the annotate web pad.
 *
 * Tauri uses the Rust `fetch_html` command (no CORS). Vite preview cannot, so
 * this middleware GETs the URL server-side and returns the bytes. Same 8 MB
 * cap and user-agent as the Rust command. Content-Type follows the origin so
 * HTML, CSS, and images can share the proxy.
 */
function webFetchProxy(): Plugin {
  const handle = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("/__lc-web-fetch")) {
      next();
      return;
    }
    let target = "";
    try {
      target = new URL(rawUrl, "http://vite.local").searchParams.get("url") ?? "";
    } catch {
      target = "";
    }
    let parsed: URL | null = null;
    try {
      parsed = new URL(target);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      res.statusCode = 400;
      res.end("that does not look like an http(s) address");
      return;
    }
    void (async () => {
      try {
        const response = await fetch(parsed.href, {
          headers: {
            accept: req.headers.accept || "*/*",
            "user-agent": WEB_FETCH_UA,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          res.statusCode = 502;
          res.end(`the page returned HTTP ${response.status}`);
          return;
        }
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > PAGE_MAX_BYTES) {
          res.statusCode = 413;
          res.end("this page is too large to annotate here");
          return;
        }
        const contentType =
          response.headers.get("content-type") || "application/octet-stream";
        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        res.setHeader("x-lc-final-url", response.url);
        res.end(buf);
      } catch (err) {
        res.statusCode = 502;
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  };
  return {
    name: "lc-web-fetch",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

// Tauri serves the built assets from a fixed port in dev and expects a
// relative base so the same bundle works from a file:// origin on Android.
export default defineConfig({
  plugins: [react(), pdfjsAssets(), webFetchProxy()],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    // Cargo locks DLLs under src-tauri/target while compiling; Vite watching
    // them on Windows throws EBUSY and kills beforeDevCommand.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      // ColorHunt has no CORS headers; the WebView/browser cannot hit it.
      // Dev preview goes through Vite. Tauri uses the Rust `colorhunt_random` command.
      "/colorhunt-feed": {
        target: "https://colorhunt.co",
        changeOrigin: true,
        rewrite: () => "/php/feed.php",
      },
    },
  },
  define: {
    // Excalidraw reads process.env.IS_PREACT at module scope.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    // The Magic Note Pad is Android 14 / Chromium; no legacy targets needed.
    target: "es2022",
    sourcemap: true,
    // Monaco is ~4 MB on its own and Excalidraw ~1 MB, so the default 500 kB
    // warning fires on chunks that are already split as far as they usefully
    // can be. Raised past them so the build stays quiet enough that a genuinely
    // new large chunk is worth looking at. Both are fetched on demand —
    // Monaco by `PseudocodeEditor`, Excalidraw by `boardChunk` — so neither is
    // on the path to Home's first paint.
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      input: {
        main: join(rootDir, "index.html"),
        hostInkLab: join(rootDir, "host-ink-lab.html"),
      },
      output: {
        /*
         * No manual chunks.
         *
         * Excalidraw and Monaco were both named here, to keep them out of the
         * initial bundle. That is the reason neither split ever worked: a
         * named manual chunk is emitted whether or not anything reaches it
         * dynamically, and Rollup files the shared code it happens to pull in
         * — React, Vite's own preload helper — *inside* it. The entry then
         * imports those from the canvas chunk, `index.html` module-preloads
         * 1.1 MB to get them, and Home waits on a board it does not draw.
         * Naming only one of the two simply moved the problem to the other.
         *
         * Both are fetched on demand — Monaco by `PseudocodeEditor`,
         * Excalidraw by `boardChunk` — so Rollup already gives each a chunk of
         * its own that nothing static reaches. That is the split these entries
         * were reaching for, and they were preventing it.
         */
      },
    },
  },
  worker: {
    // Monaco spawns its language workers as ES modules.
    format: "es",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // .mjs under src/ too: a test that needs `node:fs` has to stay out of the
      // typechecked set, or @types/node's globals come with it.
      "src/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
  },
});
