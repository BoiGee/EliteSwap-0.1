import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
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
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
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
}));
