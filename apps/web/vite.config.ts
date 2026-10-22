import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI calls /api: in development it is proxied to `openbrain serve` (port 8787); `openbrain demo` and
// `openbrain serve` can also mount this dev server directly (middleware mode), on a single port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
});
