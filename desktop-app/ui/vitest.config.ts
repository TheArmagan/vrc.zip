import { fileURLToPath, URL } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

/**
 * The test runner for `ui/`, which for a long time had none — and four silent bugs walked through
 * that gap (see CLAUDE.md §UI notes; every one of them is now a named test).
 *
 * It is a second config rather than a `test` block bolted onto `vite.config.ts` because the two
 * builds want different things: the dev server needs Tailwind and the `/api` proxy, and a unit run
 * needs neither. What it *must* share is the svelte plugin and the `$lib` alias, because the state
 * modules under test are `.svelte.ts` — runes are compiler syntax, and without the plugin `$state`
 * is an undefined identifier at import time rather than a reactive value.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
    /*
     * Svelte 5 ships a server build and a client build behind export conditions, and Vitest's
     * resolver picks the server one by default. Measured, not assumed: without this line
     * `$effect` inside an `$effect.root` **never runs and never throws** — the SSR runtime's
     * effects are no-ops, so a test asserting reactive behaviour silently observes nothing.
     * jsdom is a browser, so say so.
     */
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom",
    // Only hand-written unit tests. A bare `**/*.test.ts` would also sweep in anything vendored
    // under `src/lib/components/ui`.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
