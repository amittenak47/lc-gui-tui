import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built assets from a fixed port in dev and expects a
// relative base so the same bundle works from a file:// origin on Android.
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
  define: {
    // Excalidraw reads process.env.IS_PREACT at module scope.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    // The Magic Note Pad is Android 14 / Chromium; no legacy targets needed.
    target: "es2022",
    sourcemap: true,
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
