import type { AccountSnapshot } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import type { PresenceService } from "../accounts/presence.ts";
import type { EventBus } from "../bus/event-bus.ts";
import type { RateLimiter } from "../net/rate-limiter.ts";
import type { SecretsStore } from "../security/secrets.ts";
import {
  type ControlAccount,
  type ControlDeps,
  ControlError,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type GameSession,
  type LoginResult,
  type SettingsPatch,
  type StatusSnapshot,
  type StreamEvent,
  type Settings as WireSettings,
} from "../servers/control.ts";
import type { Settings } from "../settings.ts";
import type { Store } from "../store/index.ts";

/**
 * Implements the control API's `ControlDeps` against the live daemon.
 *
 * This is the only place daemon-internal shapes (snake_case rows, `AccountSnapshot`) are translated
 * into wire shapes. Keeping the mapping in one file is what lets the store change its column names
 * without touching HTTP, and lets the HTTP contract change without touching SQL.
 */

export interface ControlDepsOptions {
  readonly accounts: AccountManager;
  readonly store: Store;
  readonly bus: EventBus;
  readonly limiter: RateLimiter;
  readonly secrets: SecretsStore;
  readonly presence: PresenceService;
  readonly settings: Settings;
  readonly env?: NodeJS.ProcessEnv;
  readonly connectPipeline: (accountId: string) => void;
  readonly onSettingsSaved: (settings: Settings) => Promise<void>;
}

/** `AccountState` → the four states the UI's status dot knows about. */
function connectionOf(snapshot: AccountSnapshot): ControlAccount["connection"] {
  switch (snapshot.state) {
    case "online":
      return "connected";
    case "authenticating":
      return "connecting";
    case "awaiting-2fa":
      return "needs-2fa";
    default:
      return "disconnected";
  }
}

function toControlAccount(snapshot: AccountSnapshot, addedAt: number): ControlAccount {
  return {
    id: snapshot.id,
    displayName: snapshot.displayName ?? snapshot.username,
    addedAt,
    enabled: true,
    lastSeenAt: snapshot.state === "online" ? Date.now() : null,
    connection: connectionOf(snapshot),
  };
}

export function createControlDeps(options: ControlDepsOptions): ControlDeps {
  const { accounts, store, bus, limiter, secrets, presence, connectPipeline } = options;
  let settings = options.settings;

  function accountRowAddedAt(id: string): number {
    return store.getAccount(id)?.added_at ?? Date.now();
  }

  /** Makes sure an account has a row before anything references it by foreign key. */
  function ensureAccountRow(snapshot: AccountSnapshot): void {
    store.upsertAccount({
      id: snapshot.id,
      display_name: snapshot.displayName ?? snapshot.username,
      added_at: accountRowAddedAt(snapshot.id),
      enabled: 1,
      last_seen_at: snapshot.state === "online" ? Date.now() : null,
    });
  }

  return {
    async status(): Promise<StatusSnapshot> {
      return {
        degradedKeychain: secrets.degraded,
        backend: secrets.backend,
        accounts: accounts.list().length,
        rateLimit: {
          limit: limiter.globalRatePerSecond,
          // The limiter does not expose live token counts, and inventing a number here would be
          // worse than admitting we don't have one: the UI would draw a confident wrong gauge.
          remaining: limiter.isBackingOff ? 0 : limiter.globalRatePerSecond,
          queued: 0,
          retryAfter: limiter.isBackingOff ? Date.now() + limiter.backoffRemainingMs : null,
        },
      };
    },

    async listAccounts(): Promise<ControlAccount[]> {
      return accounts.list().map((s) => toControlAccount(s, accountRowAddedAt(s.id)));
    },

    async login(input): Promise<LoginResult> {
      if (settings.contact.trim() === "") {
        throw new ControlError(
          409,
          "setup_required",
          "Set a contact address in settings before signing in — VRChat requires one in the User-Agent.",
        );
      }

      try {
        const { result, account } = await accounts.add(input.username, input.password);

        if (result.status === "requires-2fa") {
          return { status: "requires-2fa", accountId: account.id, methods: result.methods };
        }

        ensureAccountRow(account.snapshot());
        connectPipeline(account.id);
        return {
          status: "ok",
          account: toControlAccount(account.snapshot(), accountRowAddedAt(account.id)),
        };
      } catch (error) {
        // A wrong password is a 401, not a 500 — the UI shows it inline on the form.
        const message = error instanceof Error ? error.message : "Sign-in failed.";
        throw new ControlError(401, "login_failed", message);
      }
    },

    async verifyTwoFactor(accountId, input): Promise<ControlAccount> {
      const account = accounts.get(accountId);
      if (!account) throw new ControlError(404, "unknown_account");

      try {
        await accounts.verifyTwoFactor(accountId, input.method, input.code);
      } catch (error) {
        const message = error instanceof Error ? error.message : "That code was not accepted.";
        throw new ControlError(401, "verification_failed", message);
      }

      ensureAccountRow(account.snapshot());
      connectPipeline(account.id);
      return toControlAccount(account.snapshot(), accountRowAddedAt(account.id));
    },

    async removeAccount(accountId): Promise<void> {
      if (!accounts.get(accountId)) throw new ControlError(404, "unknown_account");
      await accounts.remove(accountId);
      // Cascades to events and sets sessions.account_id null, which is what the schema is for.
      store.deleteAccount(accountId);
    },

    async listSessions(): Promise<GameSession[]> {
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

    async listEvents(query: EventQuery): Promise<FeedEvent[]> {
      const before = query.before ?? Date.now() + 1;
      const limit = query.limit ?? 100;

      const rows = query.accountId
        ? store.listEvents(query.accountId, before, limit)
        : accounts
            .list()
            .flatMap((s) => store.listEvents(s.id, before, limit))
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);

      return rows
        .filter((row) => (query.kind ? row.kind === query.kind : true))
        .map((row) => ({
          id: row.id,
          accountId: row.account_id,
          ts: row.ts,
          sessionId: row.session_id,
          kind: row.kind,
          subjectId: row.subject_id,
          location: row.location,
          payload: row.payload === null ? null : (JSON.parse(row.payload) as FeedEvent["payload"]),
        }));
    },

    async listFriends(accountId): Promise<FriendPresence[]> {
      // Presence is live in-memory state, not a table — see PresenceService. Reading it from
      // `friend_log` would serve stale "online" rows after a restart until the first poll landed.
      const records = accountId === null ? presence.listAll() : presence.list(accountId);

      return records.map((record) => ({
        id: record.id,
        displayName: record.displayName,
        status: record.status,
        statusDescription: record.statusDescription,
        location: record.location,
        worldId: record.worldId,
        platform: record.platform,
        lastSeenAt: record.lastSeenAt,
      }));
    },

    async getSettings(): Promise<WireSettings> {
      return settings as unknown as WireSettings;
    },

    async updateSettings(patch: SettingsPatch): Promise<WireSettings> {
      const next: Settings = {
        ...settings,
        ...(typeof patch.contact === "string" ? { contact: patch.contact } : {}),
        ...(typeof patch.useLocalDomain === "boolean"
          ? { useLocalDomain: patch.useLocalDomain }
          : {}),
        ...(typeof patch.openBrowserOnStart === "boolean"
          ? { openBrowserOnStart: patch.openBrowserOnStart }
          : {}),
        ...(Array.isArray(patch.logDirectories)
          ? { logDirectories: patch.logDirectories.filter((d) => typeof d === "string") }
          : {}),
      };

      settings = next;
      await options.onSettingsSaved(next);
      return next as unknown as WireSettings;
    },

    subscribeEvents(listener: (event: StreamEvent) => void): () => void {
      const subscription = bus.subscribe((event) => {
        listener({
          type: event.kind,
          ts: event.ts,
          payload: {
            accountId: event.accountId,
            sessionId: event.sessionId ?? null,
            subjectId: event.subjectId ?? null,
            location: event.location ?? null,
            data: (event.payload ?? null) as StreamEvent["payload"],
          } as StreamEvent["payload"],
        });
      });

      return () => {
        subscription.unsubscribe();
      };
    },
  };
}
