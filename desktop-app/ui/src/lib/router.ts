/**
 * A hash router in ~80 lines.
 *
 * Hash rather than history: the daemon serves `dist/` as plain static files with no rewrite
 * rule, so a deep path like `/friends` would 404 on reload. A hash keeps every route on
 * `index.html` without the daemon having to know the UI's route table, and it survives the
 * `file://`-style loads used by the packaged shell.
 *
 * Route params are a single trailing segment (`#/sessions/:id`), which is all Phase 1 needs.
 */

export const ROUTE_IDS = [
  "sessions",
  "accounts",
  "login",
  "friends",
  "feed",
  "gamelog",
  "notifications",
  // `#/consent/<pairingId>` — where the daemon's browser-open lands when an app asks for access.
  "consent",
  // `#/apps` — standing app access, and the kill switch. The consent route above is one moment;
  // this is what is still connected afterwards.
  "apps",
  // `#/plugins` — installs waiting to be approved, and what is installed. Both on one screen,
  // unlike apps: a plugin install is something the user started here, seconds ago.
  "plugins",
  // `#/plugin/<pluginId>/<panelId>` — one plugin's panel, as a page of its own. The only route
  // with two parameters, which is why `subParam` exists.
  "plugin",
  "settings",
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];

export const DEFAULT_ROUTE: RouteId = "sessions";

export interface Route {
  readonly id: RouteId;
  /** The trailing path segment, if the URL had one: `#/gamelog/sess_1` -> `"sess_1"`. */
  readonly param: string | null;
  /**
   * The segment after that: `#/plugin/acme.notes/settings` -> `"settings"`.
   *
   * One route needs it — a plugin panel is identified by a plugin *and* a panel, and neither is
   * meaningful without the other. Encoding both into one segment was the alternative and it makes
   * every reader learn a separator that exists nowhere else in the app.
   */
  readonly subParam: string | null;
  /** Parsed query string from `#/feed?kind=invite`. */
  readonly query: URLSearchParams;
}

function isRouteId(value: string): value is RouteId {
  return (ROUTE_IDS as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const withoutHash = hash.replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = withoutHash.split("?", 2);
  const segments = pathPart.split("/").filter((segment) => segment !== "");
  const head = segments[0] ?? "";
  const id: RouteId = isRouteId(head) ? head : DEFAULT_ROUTE;
  const raw = segments[1];
  const rawSub = segments[2];
  return {
    id,
    param: raw === undefined ? null : decodeURIComponent(raw),
    subParam: rawSub === undefined ? null : decodeURIComponent(rawSub),
    query: new URLSearchParams(queryPart),
  };
}

export function hrefFor(
  id: RouteId,
  param?: string,
  query?: Record<string, string>,
  subParam?: string,
): string {
  const tail =
    param === undefined
      ? ""
      : `/${encodeURIComponent(param)}${subParam === undefined ? "" : `/${encodeURIComponent(subParam)}`}`;
  const qs = query === undefined ? "" : new URLSearchParams(query).toString();
  return `#/${id}${tail}${qs === "" ? "" : `?${qs}`}`;
}

export function navigate(id: RouteId, param?: string, query?: Record<string, string>): void {
  window.location.hash = hrefFor(id, param, query);
}

/** Replace rather than push — used when normalising a bad hash, so Back still works. */
export function replaceRoute(id: RouteId, param?: string): void {
  const href = hrefFor(id, param);
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function onRouteChange(listener: (route: Route) => void): () => void {
  const handler = (): void => {
    listener(currentRoute());
  };
  window.addEventListener("hashchange", handler);
  return () => {
    window.removeEventListener("hashchange", handler);
  };
}
