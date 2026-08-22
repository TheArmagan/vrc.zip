/**
 * `AppApiDeps` against the live daemon — the third-party half of the control port.
 *
 * The sibling of `control-deps.ts`, and deliberately a separate file rather than a section of it.
 * The two implement different contracts for different callers: `control-deps.ts` serves the user's
 * own UI, holds nothing back, and answers about every account; this one serves an app holding one
 * grant, and every method here is written from the position that the caller is not trusted. Mixing
 * them would put those two postures in one file, where the wrong helper is one autocomplete away.
 *
 * The scope filtering itself lives in `servers/app-api.ts` as pure functions (`visibleSessions`,
 * `canSeeEvent`) so it is testable without a socket. This file is the plumbing: rows to wire
 * shapes, and the store and manager the routes are not allowed to see.
 */

import type { JsonValue, StreamFrame, WebhookRegistered, WebhookSummary } from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import { hashProxyToken, isProxyToken } from "../security/proxy-tokens.ts";
import { type AppApiDeps, type AppGrant, parseGrantScopes } from "../servers/app-api.ts";
import type { GameSession } from "../servers/control.ts";
import type { Store } from "../store/index.ts";
import type { GrantRow, WebhookRow } from "../store/types.ts";
import type { WebhookManager } from "../webhooks/index.ts";
import { WebhookUrlError } from "../webhooks/index.ts";

export interface AppApiDepsOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly webhooks: WebhookManager;
  /**
   * How often a live stream socket re-checks its grant, in milliseconds.
   *
   * Polling rather than an event, and that is a considered trade. Revocation happens in one place
   * (`revokeConnectedApp`) which already disconnects the *pipeline* mirror's sockets directly, so
   * an event would be the tidier design — but this stream is subscribed per socket and the timer is
   * one cheap indexed read per open socket per interval, against a table that is already hot.
   * Fifteen seconds is the outer bound on how long a revoked app keeps receiving events, which is
   * short enough that "revoke" still means what the button says.
   */
  readonly revocationCheckMs?: number;
}

const DEFAULT_REVOCATION_CHECK_MS = 15_000;

export function createAppApiDeps(options: AppApiDepsOptions): AppApiDeps {
  const { store, bus, webhooks } = options;
  const checkMs = options.revocationCheckMs ?? DEFAULT_REVOCATION_CHECK_MS;

  /** A grant row that is live right now, or null. Revoked and unknown are the same answer. */
  function liveGrant(grantId: string): GrantRow | null {
    const row = store.getGrant(grantId);
    return row === null || row.revoked_at !== null ? null : row;
  }

  function toAppGrant(row: GrantRow): AppGrant {
    return {
      id: row.id,
      accountId: row.account_id,
      scopes: parseGrantScopes(row.scopes),
      appName: row.app_name,
    };
  }

  function toSummary(row: WebhookRow): WebhookSummary {
    return {
      id: row.id,
      grantId: row.grant_id,
      // Resolved from the grant rather than stored on the webhook: a row that carried its own copy
      // of the app's name would keep the old one after the app updated its User-Agent.
      appName: row.grant_id === null ? null : (store.getGrant(row.grant_id)?.app_name ?? null),
      url: row.url,
      kinds: parseKinds(row.kinds),
      accountId: row.account_id,
      createdAt: row.created_at,
      disabledAt: row.disabled_at,
      disabledReason: row.disabled_reason,
      deliveredCount: row.delivered_count,
      deadCount: row.dead_count,
      lastDeliveryAt: row.last_delivery_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      pending: store.countPendingWebhookDeliveries(row.id),
    };
  }

  return {
    async resolveGrant(token): Promise<AppGrant | null> {
      // Shape first, so a session token — or anything else that is not one of ours — never reaches
      // the store at all. `hashProxyToken` on arbitrary text would be a lookup for a row that
      // cannot exist, which is only wasted work, but the shape check also means a 401 here is
      // decided by the same predicate the mirror on :7774 uses. One definition of "our token".
      if (!isProxyToken(token)) return null;
      const row = store.grantByTokenHash(hashProxyToken(token));
      if (row === null || row.revoked_at !== null) return null;
      // Touched here as well as on the mirror, because an app that only ever uses the control API
      // would otherwise read as "never used" on the Connected apps page while streaming events.
      store.touchGrant(row.id, Date.now());
      return toAppGrant(row);
    },

    watchGrant(grantId, onRevoked): () => void {
      const timer = setInterval(() => {
        if (liveGrant(grantId) === null) onRevoked();
      }, checkMs);
      // A socket must never be the reason the process stays up on the way out.
      timer.unref?.();
      return () => {
        clearInterval(timer);
      };
    },

    async listSessions(): Promise<GameSession[]> {
      // Every open session, unfiltered. Narrowing is `visibleSessions`' job in `app-api.ts`, where
      // it is a pure function with tests — a filter written twice is a filter that will one day
      // disagree with itself, and the half that leaks is the half nobody looked at.
      return store.listOpenSessions().map((row) => ({
        id: row.id,
        accountId: row.account_id,
        displayName: row.display_name,
        startedAt: row.started_at,
        vrMode: row.vr_mode,
        currentLocation: row.current_location,
        currentWorldId: row.current_world_id,
      }));
    },

    subscribeEvents(listener: (frame: StreamFrame) => void): () => void {
      const subscription = bus.subscribe((event) => {
        listener({
          type: event.kind,
          ts: event.ts,
          payload: {
            accountId: event.accountId,
            sessionId: event.sessionId ?? null,
            displayName:
              event.sessionId === null || event.sessionId === undefined
                ? null
                : (store.getSession(event.sessionId)?.display_name ?? null),
            subjectId: event.subjectId ?? null,
            location: event.location ?? null,
            // The one cast that survives, and the same one `control-deps.ts` makes: the bus types
            // `payload` as `unknown` because a producer may put anything there, while the wire can
            // only carry JSON.
            data: (event.payload ?? null) as JsonValue,
          },
        });
      });
      return () => {
        subscription.unsubscribe();
      };
    },

    async registerWebhook(grantId, registration): Promise<WebhookRegistered> {
      const grant = liveGrant(grantId);
      if (grant === null) throw new WebhookUrlError("revoked", "that grant is no longer live");

      const registered = webhooks.register({
        url: registration.url,
        kinds: registration.kinds ?? ["*"],
        // Pinned to the grant's account, never to what the caller asked for. `app-api.ts` already
        // 403s a registration naming a different one, so this is the second of two — the route
        // refuses the lie, and this makes it impossible to act on even if the route ever forgets.
        accountId: grant.account_id,
        grantId,
      });

      return { webhook: toSummary(registered.webhook), secret: registered.secret };
    },

    async listWebhooks(grantId): Promise<WebhookSummary[]> {
      return webhooks.list(grantId).map(toSummary);
    },

    async deleteWebhook(grantId, webhookId): Promise<boolean> {
      const row = webhooks.get(webhookId);
      // Another grant's webhook is reported as *absent*, not as forbidden: a 403 would confirm the
      // id exists, which is enough to enumerate what other apps on this machine are listening to.
      if (row === null || row.grant_id !== grantId) return false;
      return webhooks.remove(webhookId);
    },
  };

  function parseKinds(json: string): string[] {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter((kind) => typeof kind === "string") : [];
    } catch {
      // A row we cannot read still describes a webhook the user may want to delete, so it lists
      // with no kinds rather than vanishing out of the very list that offers the delete button.
      return [];
    }
  }
}
