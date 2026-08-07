import { createReadStream, cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * pdf.js's data directories, served in dev and copied into the build.
 *
 * `standard_fonts` holds metrics for the base-14 fonts a PDF is allowed to
 * assume the reader has, and `cmaps` maps the character encodings CJK and many
 * scanned documents use. Neither is code, so neither can be imported — pdf.js
 * fetches them by URL at render time, and without them a real textbook renders
 * with wrong glyph widths or, for CJK, blank pages.
 *
 * Copied rather than added to `public/`: they belong to a dependency, and a
 * checked-in copy would drift the moment pdfjs-dist is bumped.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["standard_fonts", "cmaps"] as const;
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

// Tauri serves the built assets from a fixed port in dev and expects a
// relative base so the same bundle works from a file:// origin on Android.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
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
    // new large chunk is worth looking at. Both load lazily; neither is in the
    // path of first board paint.
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      output: {
        // Excalidraw and Monaco are both large and independent; splitting them
        // keeps the initial board render from waiting on the code editor.
        manualChunks: {
          excalidraw: ["@excalidraw/excalidraw"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
        },
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
