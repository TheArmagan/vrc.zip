/**
 * The daemon launches the UI with `?token=…` in the URL. That token is the only credential the
 * browser ever holds, so it is:
 *
 * - stripped from the address bar immediately (it would otherwise survive in history and in any
 *   screenshot of the window),
 * - kept in `sessionStorage`, not `localStorage`, so it dies with the tab rather than lingering
 *   on disk for the next person to use this machine,
 * - sent only as `Authorization: Bearer`, never as a query parameter on subsequent requests.
 *
 * The WebSocket is the one exception: browsers cannot set headers on a `WebSocket` handshake, so
 * `/api/stream` takes the token as a query parameter. See `stream.ts`.
 */

const STORAGE_KEY = "vrcz.session-token";

let cached: string | null = null;

/** `sessionStorage` throws outright in some privacy modes; treat it as best-effort. */
function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* ignore — `cached` still carries it for the life of this page */
  }
}

/**
 * Reads `?token=` out of the launch URL, persists it, and rewrites the address bar without it.
 * Safe to call more than once; only the first call with a token in the URL does any work.
 */
export function adoptTokenFromLocation(): void {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery !== null && fromQuery !== "") {
    cached = fromQuery;
    writeStored(fromQuery);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

export function getToken(): string | null {
  cached ??= readStored();
  return cached;
}

export function clearToken(): void {
  cached = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
