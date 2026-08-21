import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  extractSessionToken,
  hostGuard,
  originGuard,
  SESSION_COOKIE,
  TOKEN_QUERY_PARAM,
  type TokenSource,
} from "../security/guards.ts";
import { sessionTokensMatch } from "../security/session-token.ts";
import { type ControlDeps, createControlApp } from "./control.ts";

/**
 * The UI server — the built bundle, plus the session API it needs. See PLAN.md §Architecture,
 * which puts ":7773 UI + session API (token in URL)" on one port for exactly this reason.
 *
 * **The API must be same-origin with the page.** Served from 7773 while the control API listens on
 * 7775, every call the bundle makes is cross-origin: `originGuard` rejects it and no CORS headers
 * come back, so the packaged build is inert while the daemon looks perfectly healthy. Only `vite
 * dev` works, because it proxies. Mounting the same routes here removes the problem rather than
 * papering over it with CORS, which would mean deciding which origins may hold a session token.
 *
 * The proxy port keeps its own separate instance. That separation is the one PLAN.md §1.8 insists
 * on — the byte-faithful mirror must not be able to serve a control route — and it is untouched.
 *
 * The UI is scaffolded in Phase 1.9, so `ui/dist` frequently does not exist yet. Rather than 404 in
 * a way that reads as a bug, an unbuilt tree gets an explicit placeholder page naming the build
 * command: someone running the daemon for the first time should learn what is missing from the
 * page, not from the terminal they are not looking at.
 *
 * Unknown paths without a file extension fall back to `index.html`, because client-side routing
 * means `/accounts/usr_…` is a real URL that only exists inside the bundle.
 */

// Re-exported for callers that had it from here. It lives in `guards.ts` now, because the cookie
// is a transport every port understands rather than a UI-server special case.
export { SESSION_COOKIE } from "../security/guards.ts";

export interface UiAppOptions {
  /** The port this instance will be bound to. The `Host` allowlist is built from it. */
  port: number;
  /** Resolves the session token. */
  token: TokenSource;
  /**
   * Mounts the control API on this port too. Omitted in tests that only exercise static serving.
   */
  deps?: ControlDeps;
  /** Where the built UI lives. Defaults to `<repo>/ui/dist`. */
  distDir?: string;
  /** Shown on the placeholder page so a first-run user can find the API. */
  controlUrl?: string;
}

/** `daemon/src/servers/ui.ts` → `<repo>/ui/dist`. */
export function defaultUiDistDir(): string {
  return resolve(import.meta.dir, "..", "..", "..", "ui", "dist");
}

export function createUiApp({ port, token, deps, distDir, controlUrl }: UiAppOptions) {
  const root = resolve(distDir ?? defaultUiDistDir());

  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))
    /*
     * Auth on the UI port has one extra transport the other two ports do not need. The launch URL
     * carries `?token=`, but the `<script>` and `<link>` requests the page then makes carry
     * nothing — a browser adds no headers to subresource loads. So a validated query token is
     * exchanged once for an HttpOnly, SameSite=Strict cookie, and the rest of the page loads on
     * that. The three standard transports still work for anything scripted.
     */
    .use(async (c, next) => {
      const expected = await token();
      const fromCookie = getCookie(c, SESSION_COOKIE);
      const presented = extractSessionToken(c);
      if (expected === "" || presented === undefined || !sessionTokensMatch(presented, expected)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const wantsCookie = c.req.query(TOKEN_QUERY_PARAM) !== undefined && fromCookie !== presented;

      await next();

      // **After** `next()`, on purpose. The static handler returns `new Response(Bun.file(...))`,
      // which *replaces* `c.res` wholesale — a cookie set before the handler runs is thrown away
      // with the response it was attached to. The page then loads, every subresource arrives with
      // no credential, and the app renders blank while the daemon looks healthy. Setting it here
      // mutates the response that is actually going out.
      if (wantsCookie) {
        setCookie(c, SESSION_COOKIE, presented, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          // No `secure`: the runtime default is plain http on loopback, and a `secure` cookie would
          // simply never be stored there.
        });
      }
    })

    // Before the catch-all: `.get("*")` would otherwise answer /api with index.html, which is
    // exactly the failure this mount exists to fix — a 200 of HTML where JSON was expected.
    .route("/", deps ? createControlApp({ port, deps, token }) : new Hono())

    .get("*", async (c) => {
      if (!existsSync(join(root, "index.html"))) {
        return c.html(placeholderPage(root, controlUrl), 200);
      }

      const requested = safeJoin(root, decodePath(c.req.path));
      if (requested !== undefined) {
        const file = Bun.file(requested);
        if (await file.exists()) return new Response(file);
      }

      // Client-side route: hand back the shell and let the bundle route it. Anything that looks
      // like an asset (it has an extension) is a genuine 404 instead, so a missing chunk fails
      // loudly rather than being served HTML with a JavaScript content type.
      if (hasExtension(c.req.path)) return c.notFound();
      return new Response(Bun.file(join(root, "index.html")));
    });

  return app;
}

export type UiApp = ReturnType<typeof createUiApp>;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Joins under `root`, or `undefined` if the result escapes it. `..` and NUL both land here. */
function safeJoin(root: string, requestPath: string): string | undefined {
  if (requestPath.includes("\0")) return undefined;
  const target = resolve(root, `.${normalize(`/${requestPath}`)}`);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}

function hasExtension(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".");
}

function placeholderPage(root: string, controlUrl: string | undefined): string {
  const control = controlUrl ?? "(not bound)";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vrc.zip — UI not built</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; padding: 2rem; }
  main { max-width: 34rem; }
  code { background: color-mix(in srgb, currentColor 12%, transparent); padding: .1em .35em;
         border-radius: .25em; }
  pre { background: color-mix(in srgb, currentColor 8%, transparent); padding: .75rem 1rem;
        border-radius: .5rem; overflow-x: auto; }
</style>
<main>
  <h1>The daemon is running. The UI is not built.</h1>
  <p>Nothing was found at <code>${escapeHtml(root)}</code>, so there is no bundle to serve yet.</p>
  <pre><code>bun run --filter @vrcz/ui build</code></pre>
  <p>The control API is live in the meantime, at <code>${escapeHtml(control)}</code>.</p>
</main>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
