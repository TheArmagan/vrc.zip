import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Svelte 5 runes only. No stores, no `export let`, no Svelte 4 reactive statements —
    // opting in globally makes the compiler reject the legacy API instead of silently
    // accepting a mixed codebase.
    runes: true,
  },
};
