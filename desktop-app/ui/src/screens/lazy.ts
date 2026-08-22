/**
 * The route table, as dynamic imports.
 *
 * Every screen used to be a static import in `App.svelte`, which put all nine of them — and
 * everything they pull in — into one entry chunk past Vite's 500 kB warning. Nobody looks at nine
 * screens on the way to the first paint, so each one is its own chunk now and the shell no longer
 * carries the settings form to show a session roster.
 *
 * **The promise cache is load-bearing, not an optimisation.** `App.svelte` reads this from inside
 * an `{#await}`, which restarts whenever the expression yields a *different* promise — so a fresh
 * promise per render would unmount and remount the screen on every reactive update, losing its
 * state and flashing the pending branch. One promise per route id, forever, keeps the block
 * settled; the browser's own module cache is not enough, because it hands back a new promise each
 * time.
 *
 * The three modals stay statically imported in `App.svelte` on purpose: they are singletons
 * mounted at the root and openable from any screen, so splitting them would only move the cost.
 */

import type { Component } from "svelte";
import type { RouteId } from "$lib/router.ts";

/**
 * Props are handed over as a bag rather than per-screen, because the route contributes exactly one
 * value — its trailing segment — under a different name per screen. See `screenProps` in `App`.
 */
type ScreenComponent = Component<Record<string, unknown>>;

/**
 * Deliberately `unknown` rather than `ScreenComponent`, and widened once in `screenFor`.
 *
 * A screen that takes no props types as `Component<Record<string, never>>`, which no props-bag
 * type is assignable to — props are contravariant, so *any* single type covering all nine screens
 * is a lie in one direction or the other. Writing the widening down here, once, is honest about
 * that; the alternative is a second route table in the template naming all nine components, which
 * is the duplication this module exists to remove. The mapping below is what keeps it safe: every
 * screen that reads a prop is handed it by `screenProps`, and both live one scroll apart.
 */
const loaders = {
  sessions: () => import("./SessionsScreen.svelte"),
  accounts: () => import("./AccountsScreen.svelte"),
  login: () => import("./LoginScreen.svelte"),
  friends: () => import("./FriendsScreen.svelte"),
  feed: () => import("./FeedScreen.svelte"),
  gamelog: () => import("./GameLogScreen.svelte"),
  notifications: () => import("./NotificationsScreen.svelte"),
  consent: () => import("./ConsentScreen.svelte"),
  apps: () => import("./ConnectedAppsScreen.svelte"),
  settings: () => import("./SettingsScreen.svelte"),
} satisfies Record<RouteId, () => Promise<{ default: unknown }>>;

const pending = new Map<RouteId, Promise<ScreenComponent>>();

/** The component for a route. The same promise every time it is asked for. */
export function screenFor(id: RouteId): Promise<ScreenComponent> {
  const cached = pending.get(id);
  if (cached !== undefined) return cached;
  const loading = loaders[id]().then((module) => module.default as ScreenComponent);
  // A chunk that failed to arrive — the daemon restarted mid-session onto a new build, the network
  // blinked — must not be remembered as failed forever. Forgetting it makes navigating back to the
  // route a retry. The rejection stays handled here, so it is the `{#await}` that reports it.
  loading.catch(() => pending.delete(id));
  pending.set(id, loading);
  return loading;
}
