/**
 * Where the control API lives, as seen from inside the page.
 *
 * The daemon binds three ports: the UI on 7773, the byte-faithful proxy on 7774, and the control
 * API on 7775. The page therefore does *not* sit on the same origin as `/api` by default, and a
 * browser cannot reach across to 7775 on its own — the control port's `originGuard` only trusts
 * origins on its own port, and it sends no CORS headers. Two things follow:
 *
 * - In development, Vite proxies `/api` to the daemon, so a relative base is correct and is what
 *   this resolves to.
 * - In production, a relative base is *also* what we want, because the fix belongs on the daemon
 *   side (mount the control routes on the UI port, or reverse-proxy them there). Pointing the
 *   bundle at `http://127.0.0.1:7775` would not work from a browser regardless of what we write
 *   here, so the UI stays honest about its origin and surfaces the failure as "daemon offline".
 *
 * `?api=` is an escape hatch for pointing a dev build at a differently-bound daemon. It is
 * remembered for the tab only, alongside the session token.
 */

const OVERRIDE_KEY = "vrcz.api-base";
const DEFAULT_BASE = "/api";

function readOverride(): string | null {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get("api");
    if (fromUrl !== null && fromUrl !== "") {
      sessionStorage.setItem(OVERRIDE_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(OVERRIDE_KEY);
  } catch {
    return null;
  }
}

/** No trailing slash. Every path in `api.ts` is written as `/status`, `/accounts`, … */
function resolveBase(): string {
  const override = readOverride();
  const base = override ?? DEFAULT_BASE;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export const API_BASE: string = resolveBase();

/** The `ws:`/`wss:` URL for `GET /api/stream`, absolute so a relative base still resolves. */
export function streamUrl(token: string | null): string {
  const url = new URL(`${API_BASE}/stream`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token !== null) url.searchParams.set("token", token);
  return url.toString();
}
