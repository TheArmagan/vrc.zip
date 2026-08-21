import { fileURLToPath, URL } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The daemon serves `dist/` statically, so the bundle is built with a relative base and dev
 * traffic to `/api` is proxied to the daemon rather than mocked. `DAEMON_PORT` mirrors whatever
 * the control API bound to; 7775 is its default (`DEFAULT_CONTROL_PORT` in
 * `daemon/src/servers/bind.ts`), and the daemon falls back to an ephemeral port when it is taken.
 */
const DAEMON_ORIGIN = `http://127.0.0.1:${process.env.DAEMON_PORT ?? "7775"}`;

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
        // Rewrites `Host` to the daemon's, which its `hostGuard` allowlist requires.
        changeOrigin: true,
        // `/api/stream` is a WebSocket; without this the upgrade never reaches the daemon.
        ws: true,
        configure(proxy) {
          /*
           * The daemon's `originGuard` 403s a present-but-foreign `Origin`, and a browser stamps
           * one on every POST and on every WebSocket handshake. In dev that value is the Vite
           * server's own origin, which the daemon has never heard of, so every write and the whole
           * event stream would 403 before reaching a handler.
           *
           * Dropping the header rather than forging one is the honest move: `Origin` was never the
           * defense here (see the comment on `originGuard` itself, and `hostGuard` above it), and
           * a request with no `Origin` is exactly what the daemon already expects from the CLI.
           * This only ever runs in `vite dev`; the production bundle is served by the daemon.
           */
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.removeHeader("origin");
          });
          proxy.on("proxyReqWs", (proxyRequest) => {
            proxyRequest.removeHeader("origin");
          });
        },
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
