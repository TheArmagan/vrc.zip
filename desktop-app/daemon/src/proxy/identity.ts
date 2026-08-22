/**
 * Who is asking, and for what. PLAN.md §Phase 2 "The login handshake".
 *
 * Two facts arrive in places nobody would design from scratch, and both choices are deliberate:
 *
 *  - **The app's identity is its `User-Agent`.** VRChat already mandates `AppName/Version contact`,
 *    so every well-behaved client already sends one, and the triple it parses into is exactly the
 *    subject a consent sheet needs to name. A malformed UA is rejected with VRChat's own 403 +
 *    `waf_code 13799` shape, which is both byte-faithful and the correct behaviour to teach.
 *  - **The scope request rides in the Basic-auth password field.** `b64(urlencode(user):urlencode(
 *    scopes))`. A stock VRChat client library therefore needs zero modification — it fills in its
 *    normal username and "password" fields and the handshake works. This is the *only* scope
 *    mechanism; an `X-VRCZip-Scopes` header was considered and dropped, because a second path means
 *    two precedence rules and an app that works against one build and not another.
 */

import { ALL_SCOPES, DEFAULT_SCOPES, expandWildcard, isScope, type Scope } from "@vrcz/shared";

/** An app, as the consent sheet names it. */
export interface AppIdentity {
  readonly name: string;
  readonly version: string;
  readonly contact: string;
}

/**
 * Parses `AppName/1.2.3 contact@example.com` — VRChat's own mandated shape, with the contact
 * optionally in parentheses, which is how most clients in the wild actually write it.
 *
 * Returns null for anything that does not carry all three parts. A UA that is merely *unusual* is
 * fine; a UA that cannot identify who to blame is not, because it is the whole consent subject.
 */
export function parseAppIdentity(userAgent: string | null | undefined): AppIdentity | null {
  if (userAgent === null || userAgent === undefined) return null;
  const trimmed = userAgent.trim();
  if (trimmed === "") return null;

  const match = /^([^/\s]+)\/(\S+)\s+(.+)$/.exec(trimmed);
  if (match === null) return null;

  const [, name, version, rawContact] = match;
  if (name === undefined || version === undefined || rawContact === undefined) return null;

  // `MyApp/1.0 (me@example.com)` and `MyApp/1.0 me@example.com` are the same claim.
  const contact = rawContact
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  if (contact === "") return null;

  // A contact nobody reads is the same as no contact. These are the two that show up constantly in
  // copy-pasted sample code, and letting them through would make the audit log useless.
  const lowered = contact.toLowerCase();
  if (lowered.endsWith("@example.com") || lowered === "your@email.here") return null;

  return { name, version, contact };
}

/** The reserved usernames meaning "let the user choose which account". */
export const ACCOUNT_PICKER_USERNAMES = ["", "*"] as const;

export function isAccountPicker(username: string): boolean {
  return (ACCOUNT_PICKER_USERNAMES as readonly string[]).includes(username.trim());
}

/** The decoded halves of a `Authorization: Basic` header. */
export interface BasicCredentials {
  readonly username: string;
  /** Where a password would be. Carries the scope request — see the module comment. */
  readonly secret: string;
}

/**
 * Decodes `Basic base64(urlencode(user):urlencode(secret))`.
 *
 * The split is on the **first** colon, matching VRChat, and both halves are percent-decoded because
 * VRChat's own login encodes them — an email with a `+` in it decodes wrong otherwise, and that is
 * a real address shape, not a hypothetical.
 */
export function parseBasicAuth(header: string | null | undefined): BasicCredentials | null {
  if (header === null || header === undefined) return null;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (match?.[1] === undefined) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }

  const split = decoded.indexOf(":");
  if (split < 0) return null;

  try {
    return {
      username: decodeURIComponent(decoded.slice(0, split)),
      secret: decodeURIComponent(decoded.slice(split + 1)),
    };
  } catch {
    // A stray `%` that is not a valid escape. Treated as malformed rather than passed through
    // raw — guessing which half of a credential was meant literally is not a decision to make.
    return null;
  }
}

/** What the app asked for, or the reason it was refused. */
export type ScopeRequest =
  | { readonly ok: true; readonly scopes: readonly Scope[] }
  | { readonly ok: false; readonly unknown: readonly string[] };

/**
 * Parses the comma-separated scope list out of the password field.
 *
 * Empty means the minimal read-only default set. `*` expands to every non-dangerous scope —
 * dangerous ones are **never reachable through a wildcard** and must be named individually, which
 * is enforced in `expandWildcard` rather than here so there is one place it can be got wrong.
 *
 * An unknown scope string is a **hard failure, never silently dropped**: an app that asked for
 * `friends:reed` and got a working grant without it would fail later, somewhere unrelated, with a
 * 403 nobody can trace back to a typo.
 */
export function parseScopeRequest(raw: string): ScopeRequest {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  if (parts.length === 0) return { ok: true, scopes: DEFAULT_SCOPES };
  if (parts.length === 1 && parts[0] === "*") return { ok: true, scopes: expandWildcard() };

  // A field that is not a scope request at all gets the same minimal default set as an empty one.
  //
  // PLAN.md claims a stock VRChat client library works unmodified, and that claim and the hard
  // failure below were in direct contradiction: an unmodified client puts a **real password** here,
  // because it has never heard of vrc.zip. Reading `hunter2` as a typo'd scope and answering 400
  // makes the login impossible for exactly the clients the mechanism exists to support — VRCX among
  // them. The password is neither stored nor forwarded; it is parsed here and discarded.
  //
  // The typo case below keeps its hard failure, because the two are distinguishable: `friends:reed`
  // names a resource the registry knows and a verb it does not, while a password names nothing.
  if (!looksLikeScopeRequest(parts)) return { ok: true, scopes: DEFAULT_SCOPES };

  const scopes: Scope[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    if (isScope(part)) {
      if (!scopes.includes(part)) scopes.push(part);
    } else {
      unknown.push(part);
    }
  }

  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, scopes };
}

/** The resource half of every scope: `friends`, `users`, `files`, and so on. */
const SCOPE_RESOURCES = new Set(ALL_SCOPES.map((scope) => scope.slice(0, scope.indexOf(":"))));

/**
 * True when the field was plausibly *meant* as a scope list.
 *
 * One part naming a resource the registry knows is enough. That is deliberately a low bar: the
 * question is not "is this valid" — the loop above answers that, and answers it strictly — but "was
 * this an attempt at scopes, or a password from a client that does not know about us".
 */
function looksLikeScopeRequest(parts: readonly string[]): boolean {
  return parts.some((part) => {
    const colon = part.indexOf(":");
    return colon > 0 && SCOPE_RESOURCES.has(part.slice(0, colon));
  });
}

/** Scopes in `wanted` that `granted` does not cover. The consent sheet shows only this delta. */
export function missingScopes(granted: readonly Scope[], wanted: readonly Scope[]): Scope[] {
  return wanted.filter((scope) => !granted.includes(scope));
}
