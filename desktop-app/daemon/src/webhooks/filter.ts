/**
 * Deciding whether one bus event belongs to one webhook.
 *
 * Two independent filters, and they combine with AND: the **kind patterns** and the **account**.
 *
 * The kind grammar is deliberately the same three forms `EventBus.subscribe` already understands —
 * an exact `friend.online`, a `family.*` prefix, or `*` for everything — because a user who has read
 * how bus subscriptions match should not have to learn a second, subtly different language for
 * webhooks. Prefixes are matched segment-wise rather than as a string prefix: `friend.*` must not
 * match a future `friendship.created`, which a naive `startsWith("friend.")` would get right only by
 * the accident of the dot and a naive `startsWith("friend")` would get wrong outright.
 *
 * Multi-segment prefixes (`gamelog.player.*`) work by construction and cost nothing extra, which is
 * why the implementation walks the pattern instead of special-casing one dot.
 */

import type { BusEvent } from "../bus/event-bus.ts";

/** Matches every kind. */
export const WILDCARD = "*";

/** The subset of a webhook row this file needs. Structural, so a test can pass a literal. */
export interface WebhookFilter {
  /** Kind patterns, already parsed out of the row's JSON. */
  readonly kinds: readonly string[];
  /** Null means every account, including events that belong to none. */
  readonly accountId: string | null;
}

/**
 * Parses `webhooks.kinds`, which is JSON in the database and must be treated as untrusted here.
 *
 * A row that fails to parse yields **no patterns**, so the webhook matches nothing. Failing closed
 * is the only safe direction: a corrupt filter that defaulted to `*` would start sending a user's
 * whole event stream to an endpoint that asked for one kind of it.
 */
export function parseKindPatterns(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/**
 * Validates patterns at registration, so a typo is a 400 rather than a webhook that silently never
 * fires. Returns the normalised list; throws nothing — the caller decides what an empty list means.
 *
 * Normalisation is lowercasing and de-duplication. Kinds are lower-case dotted paths throughout the
 * shared vocabulary, and a stored `Friend.Online` would be a filter that looks right in the UI and
 * matches nothing.
 */
export function normaliseKindPatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim().toLowerCase();
    if (trimmed === "") continue;
    if (trimmed === WILDCARD) return [WILDCARD];
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/.test(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/** True when `kind` matches any of the patterns. An empty pattern list matches nothing. */
export function matchesKind(patterns: readonly string[], kind: string): boolean {
  for (const pattern of patterns) {
    if (pattern === WILDCARD) return true;
    if (pattern === kind) return true;

    if (pattern.endsWith(".*")) {
      // `friend.` — including the dot, which is what stops `friendship.created` matching.
      const prefix = pattern.slice(0, -1);
      if (kind.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * The whole decision for one webhook and one event.
 *
 * The account rule reads the way the invariant does: a webhook scoped to an account sees that
 * account's events **and nothing else**, including the null-account events a game client signed into
 * an unmanaged account produces (PLAN.md §1.7). Those reach a webhook only if it asked for every
 * account, because there is no account for a scoped webhook to have been granted them under.
 */
export function webhookMatches(filter: WebhookFilter, event: BusEvent): boolean {
  if (filter.accountId !== null && filter.accountId !== event.accountId) return false;
  return matchesKind(filter.kinds, event.kind);
}
