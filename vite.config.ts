import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  // GitHub Pages project sites serve from /<repo>/ unless a custom domain
  // is attached (which serves from /). Set via the GITHUB_PAGES_BASE build
  // env var (see .github/workflows/deploy-pages.yml) so switching to the
  // custom domain later is a one-line workflow change, not a code change.
  base: process.env.GITHUB_PAGES_BASE || "/",
  server: {
    host: "localhost",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  // ES module format (not the default iife) so a worker bundle can contain a
  // dynamic import() — backgroundSegmentation.worker.ts lazy-loads
  // @mediapipe/tasks-vision so that ~9MB WASM runtime only ever downloads
  // for sessions that actually turn the custom-background feature on.
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  build: {
    rollupOptions: {
      output: {
        // Only the truly universal runtime (needed by every route) goes in
        // its own cacheable chunk. Deliberately NOT bundling all of
        // node_modules into one vendor blob — this app has route-specific
        // heavy deps (recharts on /admin only, @decartai/sdk on /studio
        // only) that most visitors never touch; forcing those into a chunk
        // every visitor downloads would trade one problem for a worse one.
        // This still fixes the actual duplication: react/react-dom/
        // react-router-dom were previously being bundled into all three
        // largest route chunks independently instead of shared once.
        manualChunks(id) {
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/react-router-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
        },
      },
    },
  },
}));
