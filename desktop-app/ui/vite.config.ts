import { fileURLToPath, URL } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The daemon serves `dist/` statically and owns `/api`, so the bundle is built with a relative
 * base and dev traffic to `/api` is proxied to the daemon rather than mocked. `DAEMON_PORT`
 * mirrors whatever the daemon bound to; 8787 is the development default.
 */
const DAEMON_ORIGIN = `http://127.0.0.1:${process.env.DAEMON_PORT ?? "8787"}`;

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: DAEMON_ORIGIN,
        changeOrigin: true,
        // `/api/stream` is a WebSocket; without this the upgrade never reaches the daemon.
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
});
