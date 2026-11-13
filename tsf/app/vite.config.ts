/**
 * The web build (DESIGN 11, 3 "Web build"). The server runs `vite build --outDir <dist/web-hash tmp dir>` on first start
 * and serves the result; `npm run build:web` builds into `dist/web`. With `tsf start --dev` the server proxies the page
 * to this dev server and inlines the theme; HMR's websocket goes straight to port 5173.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  base: "/",
  plugins: [react()],
  resolve: {
    // One copy of the libraries that @pw/ui shares with the app.
    dedupe: ["react", "react-dom", "lucide-react", "radix-ui"],
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    // React, react-markdown and pw-ui in one chunk: about 500 kB before gzip.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { clientPort: 5173 },
  },
});
