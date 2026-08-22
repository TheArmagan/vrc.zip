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

import {
  ALL_SCOPES,
  DEFAULT_SCOPES,
  expandSuperWildcard,
  expandWildcard,
  isScope,
  type Scope,
} from "@vrcz/shared";

/** An app, as the consent sheet names it. */
export interface AppIdentity {
  readonly name: string;
  readonly version: string;
  readonly contact: string;
}

/**
 * Version-shaped: `1.2.3`, `v2`, `2026.07.18`, `1.0.0-beta.2`. Starts with a digit after an
 * optional `v`, which is enough to tell a version from the rest of a User-Agent.
 */
const VERSION_LIKE = /^v?\d[\w.\-+]*$/;

/**
 * HTTP libraries advertising themselves rather than an app.
 *
 * These are the only User-Agents still refused, and refusing them is the half of the old strict rule
 * worth keeping: they name a library, not something a user could recognise on a consent sheet, and
 * VRChat's own WAF blocks several of them outright — so an app that gets a 403 here learns something
 * true about what will happen in production.
 */
const GENERIC_CLIENTS = [
  "python-requests",
  "python-urllib",
  "urllib",
  "axios",
  "curl",
  "wget",
  "node-fetch",
  "got",
  "okhttp",
  "go-http-client",
  "java",
  "apache-httpclient",
  "libwww-perl",
  "postmanruntime",
  "insomnia",
  "restsharp",
  "httpie",
  "bun",
  "undici",
];

/**
 * Parses the app's User-Agent into the triple a consent sheet names it by.
 *
 * **The strict `Name/Version contact` form was rejecting clients VRChat itself accepts.** VRCX sends
 * `VRCX 2026.07.18` — a space, no slash, no contact — and works fine against the real API, so
 * answering it with `waf_code 13799` taught something false and made the mirror unreachable for the
 * app it most needed to serve. Anything that names *something* is now accepted, and the shape is
 * parsed on a best-effort basis rather than demanded.
 *
 * **A missing contact costs nothing, which is why it is no longer required.** The app's User-Agent
 * never reaches VRChat: the request pipeline always substitutes `vrc.zip/<version> (<user contact>)`
 * so traffic is attributed to the thing actually making it (PLAN.md §Phase 2 Enforcement). So the
 * contact here was never part of VRChat compliance — it only ever labelled a consent sheet, and a
 * name and version label one perfectly well. A placeholder contact is dropped to empty rather than
 * failing the whole app, which is the same judgement as before applied to a now-optional field.
 *
 * Still refused: nothing at all, and a bare HTTP library name. Both are cases where there is no app
 * to put in front of the user, which is what the consent gesture needs.
 */
export function parseAppIdentity(userAgent: string | null | undefined): AppIdentity | null {
  if (userAgent === null || userAgent === undefined) return null;
  const trimmed = userAgent.trim();
  if (trimmed === "") return null;

  const [head = "", ...rest] = trimmed.split(/\s+/);
  const tail = rest.join(" ");

  // `MyApp/1.2.3 …` — VRChat's mandated form, and still the one to prefer.
  const slash = head.indexOf("/");
  if (slash > 0) {
    const name = head.slice(0, slash);
    return refuse(name)
      ? null
      : { name, version: head.slice(slash + 1), contact: cleanContact(tail) };
  }

  // `VRCX 2026.07.18` — a name and a version with a space between them. VRCX's actual shape.
  const [second = "", ...after] = rest;
  if (VERSION_LIKE.test(second)) {
    return refuse(head)
      ? null
      : { name: head, version: second, contact: cleanContact(after.join(" ")) };
  }

  // A name and nothing parseable after it. Still an app, still nameable.
  return refuse(head) ? null : { name: head, version: "", contact: cleanContact(tail) };
}

/** True for a User-Agent that names a library rather than an app. */
function refuse(name: string): boolean {
  const lowered = name.toLowerCase();
  return GENERIC_CLIENTS.some(
    (generic) => lowered === generic || lowered.startsWith(`${generic}/`),
  );
}

/**
 * The contact, or empty.
 *
 * `MyApp/1.0 (me@example.com)` and `MyApp/1.0 me@example.com` are the same claim. A placeholder is
 * the same as none: a contact nobody reads is worse than an absent one, because it looks like
 * something in an audit row.
 */
function cleanContact(raw: string): string {
  const contact = raw
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  const lowered = contact.toLowerCase();
  return lowered.endsWith("@example.com") || lowered === "your@email.here" ? "" : contact;
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
 * Empty means the minimal read-only default set. `*` expands to every non-dangerous scope, and `**`
 * to **every** scope including the dangerous ones. Both expansions live in `@vrcz/shared` rather
 * than here, so there is one place the difference between them can be got wrong.
 *
 * `**` is the deliberate escape hatch, and it is not self-service: it decides what the consent sheet
 * *asks for*, while the user reading a six-digit code out of vrc.zip decides whether it is granted,
 * with the dangerous scopes in their own block behind a second toggle. The two hard denials are
 * unaffected either way — they are route table flags, not scopes.
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
  // `**` before `*`, or the shorter one matches first and the difference silently disappears.
  if (parts.length === 1 && parts[0] === "**") return { ok: true, scopes: expandSuperWildcard() };
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
