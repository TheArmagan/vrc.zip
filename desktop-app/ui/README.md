# @vrcz/ui

Svelte 5 + shadcn-svelte frontend. **Not scaffolded yet — this lands in Phase 1.9.**

It is a workspace member from Phase 1.0 so that `@vrcz/shared` resolves here the same way it does
everywhere else, and so the Vite scaffold drops into an existing slot rather than restructuring the
workspace later. Deliberately carries no Svelte/Vite dependencies until 1.9; a half-configured build
is worse than an absent one.

Excluded from the root `tsconfig.json` typecheck — Svelte needs `svelte-check`, which arrives with
the scaffold.
