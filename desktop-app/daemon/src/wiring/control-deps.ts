import type { AccountSnapshot } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import type { PresenceService } from "../accounts/presence.ts";
import type { EventBus } from "../bus/event-bus.ts";
import { ImageCache } from "../net/image-cache.ts";
import type { RateLimiter } from "../net/rate-limiter.ts";
import { vrcFetch } from "../net/request.ts";
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
  type NotificationItem,
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

/**
 * Maps an upstream failure onto a status the control API is allowed to return.
 *
 * Only the ones a sign-in can legitimately produce pass through; anything else becomes a 401 rather
 * than inventing a code the UI has no branch for.
 */
function loginStatusOf(error: unknown): 401 | 403 | 429 | 502 {
  const status = (error as { status?: unknown }).status;
  if (status === 403) return 403;
  if (status === 429) return 429;
  if (typeof status === "number" && status >= 500) return 502;
  return 401;
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
    iconUrl: snapshot.iconUrl,
  };
}

export function createControlDeps(options: ControlDepsOptions): ControlDeps {
  const { accounts, store, bus, limiter, secrets, presence, connectPipeline } = options;
  let settings = options.settings;

  // One cache for the whole daemon. Its de-duplication only works if every caller shares it, and a
  // per-request instance would also re-run the eviction sweep on every avatar.
  const images = new ImageCache(options.env === undefined ? {} : { env: options.env });

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
        // A wrong password is a 401, not a 500 — the UI shows it inline on the form. The upstream
        // status is preserved rather than flattened, because 401 and 403 mean different things to
        // the person reading the message: one is "that password is wrong", the other is "VRChat
        // will not let this sign-in through", and only the second needs action outside vrc.zip.
        const message = error instanceof Error ? error.message : "Sign-in failed.";
        throw new ControlError(loginStatusOf(error), "login_failed", message);
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

    async inviteSelfTo(accountId, target): Promise<void> {
      const account = accounts.get(accountId);
      if (!account) throw new ControlError(404, "unknown_account");

      // A self-invite needs a live auth cookie, and an account that is signed out or sitting on a
      // 2FA challenge has none. Saying so is better than letting `vrcFetch` discover it as a 401
      // and re-auth into a challenge nobody is watching.
      if (account.snapshot().state !== "online") {
        throw new ControlError(
          409,
          "account_offline",
          "That account is not signed in, so VRChat has nobody to send the invite to.",
        );
      }

      // Interpolated, not encoded: `parseInviteLocation` has already restricted both halves to
      // characters percent-encoding leaves alone, so encoding here would be a no-op that only
      // makes the path harder to read against VRChat's own spec.
      const path = `/invite/myself/to/${target.worldId}:${target.instanceId}`;
      const response = await vrcFetch(account.context(), path, { method: "POST" });

      // Drained either way — an undrained body holds the connection open, and nothing here wants
      // VRChat's notification object back. The UI's success signal is the HTTP status.
      const body = await response.text().catch(() => "");
      if (response.ok) return;

      // Three upstream answers mean genuinely different things to the person who clicked, so they
      // keep their own codes rather than collapsing into one "it failed".
      if (response.status === 403) {
        throw new ControlError(
          403,
          "invite_forbidden",
          "VRChat will not let this account into that instance.",
        );
      }
      if (response.status === 404) {
        throw new ControlError(404, "unknown_instance", "That instance no longer exists.");
      }
      throw new ControlError(
        502,
        "invite_failed",
        `VRChat returned ${String(response.status)}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
      );
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
        iconUrl: record.iconUrl,
        lastSeenAt: record.lastSeenAt,
      }));
    },

    async listNotifications(accountId): Promise<NotificationItem[]> {
      const ids = accountId === null ? accounts.list().map((s) => s.id) : [accountId];

      return ids
        .flatMap((id) => store.listNotifications(id))
        .sort((a, b) => b.ts - a.ts)
        .map((row) => ({
          id: row.id,
          accountId: row.account_id,
          ts: row.ts,
          type: row.type,
          senderUserId: row.sender_user_id,
          senderDisplayName: row.sender_display_name,
          message: row.message,
          seen: row.seen === 1,
          data: row.data === null ? null : (JSON.parse(row.data) as NotificationItem["data"]),
        }));
    },

    async markNotificationSeen(id): Promise<void> {
      store.markNotificationSeen(id);
    },

    async fetchImage(url) {
      // The URL has already cleared the host allowlist in `control.ts`. Everything below still goes
      // through an `Account` and therefore through `vrcFetch` — the rate limiter, the mandatory
      // User-Agent, and one account's cookies are all structural here, not optional. `vrcFetch`
      // passes an absolute URL through untouched, which is what makes an image URL usable at all.
      return await images.load(url, async (absolute) => {
        const online = accounts.list().find((snapshot) => snapshot.state === "online");
        const account = online ? accounts.get(online.id) : undefined;
        if (!account) {
          throw new ControlError(
            503,
            "no_account",
            "No account is online, and VRChat images cannot be fetched without one.",
          );
        }

        // Charged to the file tier, not the API tier: VRChat meters files separately at 300/s
        // per IP, and a friends screen is a few hundred icons. Billing those to the 100/s API
        // budget would queue presence polling behind pictures on every cold start.
        const response = await vrcFetch(account.context(), absolute, {
          headers: { Accept: "image/*" },
          rateClass: "file",
        });

        if (response.status === 404) {
          await response.arrayBuffer().catch(() => undefined);
          return null;
        }
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          throw new ControlError(502, "image_fetch_failed", `VRChat returned ${response.status}`);
        }

        // Refuse an oversized body before buffering it. A wrong or hostile URL that still cleared
        // the allowlist should not be able to pull hundreds of megabytes into memory on its way to
        // being rejected by the cache's own cap.
        const declared = Number(response.headers.get("Content-Length") ?? "");
        if (Number.isFinite(declared) && declared > images.maxImageBytes) {
          await response.arrayBuffer().catch(() => undefined);
          throw new ControlError(502, "image_too_large", "VRChat image exceeds the size cap");
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, contentType: response.headers.get("Content-Type") };
      });
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
