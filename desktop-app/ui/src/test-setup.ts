/**
 * Registers `@testing-library/jest-dom`'s DOM matchers (`toBeInTheDocument`, `toHaveAttribute`, …)
 * on Vitest's `expect`. The `/vitest` entry point is the one that also augments the type of
 * `expect`, so the matchers typecheck under `svelte-check` rather than only working at runtime.
 */
import "@testing-library/jest-dom/vitest";
