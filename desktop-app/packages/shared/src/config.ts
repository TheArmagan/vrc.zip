/**
 * Names and numbers the daemon and the UI must agree on byte-for-byte: if the daemon puts the token
 * in `?token=` and the page looks for `?session=`, nothing fails loudly — the UI simply boots
 * unauthenticated. These lived in two places (`daemon/src/security/guards.ts`,
 * `daemon/src/servers/bind.ts`) plus hard-coded string literals in the UI, so they are hoisted here
 * where a rename can only happen once.
 */

/** Header the UI sends when it would rather not put the token in a query string. */
export const TOKEN_HEADER = "X-Vrcz-Token";

/** Query parameter the launch URL carries, so the first navigation can authenticate itself. */
export const TOKEN_QUERY_PARAM = "token";

/** Set once the launch URL's `?token=` has been validated, so subresources authenticate too. */
export const SESSION_COOKIE = "vrcz_session";

export const DEFAULT_UI_PORT = 7773;
export const DEFAULT_PROXY_PORT = 7774;
export const DEFAULT_CONTROL_PORT = 7775;

/**
 * The forward proxy: a real HTTP proxy an app is configured with, rather than a base URL it points
 * at. It rewrites VRChat traffic onto `DEFAULT_PROXY_PORT`. See `daemon/src/forward-proxy/`.
 */
export const DEFAULT_FORWARD_PROXY_PORT = 7776;

/** Loopback by name resolves to 127.0.0.1; binding the literal keeps IPv6 out of the picture. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

/**
 * The URL to open in the browser: the UI origin with the session token attached.
 *
 * The token is generated from raw bytes, so it can contain characters that are not query-safe.
 * Encoding is not cosmetic: an unescaped `+` arrives at the daemon as a space and the token no
 * longer matches, which is exactly the bug the composition root shipped with when it built this
 * string inline.
 */
export function launchUrl(uiUrl: string, sessionToken: string): string {
  return `${uiUrl}/?${TOKEN_QUERY_PARAM}=${encodeURIComponent(sessionToken)}`;
}

/**
 * Where the UI bundle lives inside the single-file build, as `bun build --compile --asset` names it.
 *
 * Measured, not assumed: Bun keys an embedded directory by its **own name**, not by the path it was
 * given. `--asset=ui/dist` therefore produces `dist/index.html`, not `ui/dist/index.html`, and the
 * flag's leading directories never appear. Rename Vite's `outDir` and this has to move with it.
 *
 * It lives here rather than in either half because the two halves are a build script and a runtime
 * server that never import each other, and a prefix that agrees in only one of them serves a blank
 * page from a daemon that looks perfectly healthy.
 */
export const EMBEDDED_UI_PREFIX = "dist/";
