import type { MiddlewareHandler } from "hono";
import { AUTHCOOKIE_PATTERN, looksLikeRealAuthCookie } from "../security/proxy-tokens.ts";

/**
 * Opt-in request logging for the proxy ports. Off unless asked for.
 *
 * Debugging a third-party app against the mirror is otherwise guesswork: the app reports "it did not
 * work", and the interesting facts — which operation the path resolved to, whether a grant was
 * found, what scope was wanted, what upstream actually said — are all inside the daemon. Every bug
 * reported against this proxy so far was diagnosed by reconstructing exactly this line by hand.
 *
 * **Redaction happens here, at the logger, not at the call sites.** That is the same rule PLAN.md
 * §Phase 2 states for the leak table, and for the same reason: a call site that has to remember to
 * redact is a call site that will eventually forget, and the consequence is a real VRChat session
 * sitting in a log file the user then pastes into a bug report. So the logger takes whole `Headers`
 * and whole bodies and is itself responsible for what comes out.
 *
 * What is never printed, at any level:
 *
 *  - **Cookie values.** Names only, plus a tag saying whether the value was ours, a real VRChat
 *    credential, or neither — which is the part worth knowing and the part safe to say.
 *  - **`Authorization`.** The scheme only. On the mirror's login path that header carries the user's
 *    actual VRChat password.
 *  - **Any `authcookie_…` run**, wherever it appears, including inside a body.
 *  - **Pairing codes and passwords in JSON bodies.** The six digits are a consent credential.
 */

/** How much to say. Each level includes the ones before it. */
export type ProxyLogLevel = "off" | "basic" | "headers" | "body";

const LEVELS: Record<string, ProxyLogLevel> = {
  "": "off",
  "0": "off",
  off: "off",
  false: "off",
  "1": "basic",
  on: "basic",
  true: "basic",
  basic: "basic",
  headers: "headers",
  header: "headers",
  body: "body",
  bodies: "body",
  full: "body",
};

/** The environment variable, named once. */
export const PROXY_LOG_ENV = "VRCZIP_PROXY_LOG";

/**
 * Bodies are truncated at this many characters.
 *
 * A friends list is hundreds of kilobytes of JSON and scrolls the one line you needed off the top of
 * the terminal. The head of a body is enough to tell an error envelope from a payload.
 */
export const MAX_LOGGED_BODY = 2000;

export function parseProxyLogLevel(raw: string | undefined): ProxyLogLevel {
  return LEVELS[(raw ?? "").trim().toLowerCase()] ?? "off";
}

export interface ProxyLogger {
  readonly level: ProxyLogLevel;
  /** False for the default logger, so a caller can skip building a line nobody will print. */
  readonly enabled: boolean;
  /** True only at `body`, where the caller has to buffer something to log it. */
  readonly wantsBodies: boolean;
  /** One event: `[vrcz:proxy] GET /api/1/config -> 200 getConfig 41ms`. */
  line(channel: string, message: string): void;
  /** Header block, indented under the line it belongs to. Silent below `headers`. */
  headers(label: string, headers: Headers): void;
  /** A body, redacted and truncated. Silent below `body`. */
  body(label: string, text: string | null): void;
}

const DISABLED: ProxyLogger = {
  level: "off",
  enabled: false,
  wantsBodies: false,
  line: () => {},
  headers: () => {},
  body: () => {},
};

export interface ProxyLoggerOptions {
  /** Overridden in tests, which assert on the lines rather than on the terminal. */
  readonly write?: (line: string) => void;
}

export function createProxyLogger(
  env: NodeJS.ProcessEnv = process.env,
  options: ProxyLoggerOptions = {},
): ProxyLogger {
  const level = parseProxyLogLevel(env[PROXY_LOG_ENV]);
  if (level === "off") return DISABLED;

  // `console.info` rather than `console.debug`: this output was explicitly asked for, so it is not
  // debug noise to be filtered out by a log level somewhere else.
  const write = options.write ?? ((line: string) => console.info(line));

  return {
    level,
    enabled: true,
    wantsBodies: level === "body",
    line(channel, message) {
      write(`[vrcz:${channel}] ${message}`);
    },
    headers(label, headers) {
      if (level === "basic") return;
      for (const line of describeHeaders(headers)) write(`    ${label} ${line}`);
    },
    body(label, text) {
      if (level !== "body" || text === null || text === "") return;
      write(`    ${label} ${truncate(redact(text))}`);
    },
  };
}

/** A logger that is on regardless of the environment. For tests, and for `--proxy-log` if it lands. */
export function forceProxyLogger(
  level: ProxyLogLevel,
  options: ProxyLoggerOptions = {},
): ProxyLogger {
  return createProxyLogger({ [PROXY_LOG_ENV]: level }, options);
}

// --- redaction ---------------------------------------------------------------

/** Header values that are never printed, whatever they contain. */
const NEVER_PRINTED = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

/**
 * One `name: value` line per header, with the unprintable ones described instead of shown.
 *
 * A described header is more useful than a hidden one: "the app sent an `auth` cookie and it was one
 * of ours" is the fact you are usually after, and it is safe to say.
 */
export function describeHeaders(headers: Headers): string[] {
  const lines: string[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!NEVER_PRINTED.has(lower)) {
      lines.push(`${name}: ${redact(value)}`);
      continue;
    }
    if (lower === "cookie" || lower === "set-cookie") {
      lines.push(`${name}: ${describeCookies(value)}`);
      continue;
    }
    // `Basic <base64>` on the login path decodes to the user's real VRChat password.
    lines.push(`${name}: ${value.split(" ")[0] ?? "?"} <redacted>`);
  }
  return lines;
}

/** `auth=<ours>; twoFactorAuth=<real>` — every name, no value. */
function describeCookies(header: string): string {
  const parts: string[] = [];
  for (const chunk of header.split(";")) {
    const eq = chunk.indexOf("=");
    const name = (eq < 0 ? chunk : chunk.slice(0, eq)).trim();
    if (name === "") continue;
    const value = eq < 0 ? "" : chunk.slice(eq + 1).trim();
    parts.push(`${name}=${classify(value)}`);
  }
  return parts.length === 0 ? "<empty>" : parts.join("; ");
}

/**
 * What a credential-shaped value is, without saying what it is.
 *
 * The ours/real distinction is the single most useful thing a log can tell you on this path, because
 * "a real VRChat cookie reached the client" is the one outcome the whole egress filter exists to
 * make impossible. Seeing `<real>` in a response log is a bug report on its own.
 */
function classify(value: string): string {
  if (value === "") return "<empty>";
  if (!value.startsWith("authcookie_")) return "<redacted>";
  return looksLikeRealAuthCookie(value) ? "<REAL VRCHAT CREDENTIAL>" : "<vrc.zip token>";
}

/** JSON fields whose values are credentials. Matched loosely, since the body may be malformed. */
const SENSITIVE_JSON_FIELDS =
  /"(password|code|totp|otp|secret|authToken|twoFactorAuth)"\s*:\s*"[^"]*"/gi;

/** Replaces every credential-shaped run in arbitrary text. Safe to call on anything. */
export function redact(text: string): string {
  return text
    .replace(AUTHCOOKIE_PATTERN, (match) =>
      looksLikeRealAuthCookie(match)
        ? "authcookie_<REAL VRCHAT CREDENTIAL>"
        : "authcookie_<vrc.zip>",
    )
    .replace(SENSITIVE_JSON_FIELDS, (_match, field: string) => `"${field}":"<redacted>"`);
}

function truncate(text: string): string {
  const flat = text.replace(/\r?\n/g, " ");
  return flat.length > MAX_LOGGED_BODY
    ? `${flat.slice(0, MAX_LOGGED_BODY)}… (${flat.length} chars)`
    : flat;
}

/** Reads a body for logging without ever letting that failure become the request's failure. */
export async function bodyForLog(source: Request | Response): Promise<string | null> {
  try {
    return await source.clone().text();
  } catch {
    return null;
  }
}

// --- the mirror's access log -------------------------------------------------

/**
 * Logs every request the mirror handles, whichever way it is answered.
 *
 * Deliberately wrapping *all* routes rather than only the pass-through, because the answers that
 * are hardest to debug are the ones the pass-through never sees. A path that resolves to no
 * operation is answered with VRChat's real 404 long before any of this — which is exactly how a
 * missing route table entry looks from outside, and it is what made every avatar URL a silent 404
 * until someone thought to check the table rather than the network.
 *
 * The operation name comes from a second `matchRoute` call, which is wasted work and is only done
 * when logging is on. It is worth it: `-> 404 (no route)` and `-> 404 upstream` are the same three
 * digits and completely different problems.
 */
export function proxyAccessLog(logger: ProxyLogger, resolve: RouteResolver): MiddlewareHandler {
  return async function proxyAccessLogMiddleware(c, next) {
    if (!logger.enabled) {
      await next();
      return;
    }

    const started = Date.now();
    // An upgrade is not a request/response pair to buffer. By the time it returns, Bun owns the
    // socket and the response is a formality; cloning it is at best pointless and at worst breaks
    // the handshake. The frames themselves are the pipeline mirror's business, not the access log's.
    const upgrade = c.req.header("upgrade") !== undefined;
    // Cloned before the route reads it, so the route still gets its own body.
    const requestBody = logger.wantsBodies && !upgrade ? await bodyForLog(c.req.raw) : null;
    const app = c.req.header("user-agent")?.split(" ")[0] ?? "unknown";

    await next();

    const elapsed = Date.now() - started;
    const operation = upgrade ? "pipeline (websocket)" : resolve(c.req.method, c.req.path);
    logger.line(
      "proxy",
      `${c.req.method} ${c.req.path} -> ${String(c.res.status)} ${operation} ${app} ${String(elapsed)}ms`,
    );
    logger.headers("req", c.req.raw.headers);
    logger.body("req", requestBody);
    logger.headers("res", c.res.headers);
    logger.body("res", logger.wantsBodies && !upgrade ? await bodyForLog(c.res) : null);
  };
}

/** Names the operation a request maps to, for the log line. `createProxyApp` supplies it. */
export type RouteResolver = (method: string, path: string) => string;
